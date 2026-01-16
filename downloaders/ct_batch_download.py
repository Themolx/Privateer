#!/usr/bin/env python3
"""
Czech Television (Česká televize) Batch Downloader
Downloads videos from ceskatelevize.cz using their VOD API.

Usage:
    python ct_batch_download.py                      # Use wanted_ct.json in current dir
    python ct_batch_download.py --json videos.json   # Use custom JSON file
    python ct_batch_download.py --output-dir /path   # Custom output directory
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import requests


def get_stream_url(idec: str) -> dict:
    """Get stream info from CT VOD API."""
    api_url = (
        f"https://api.ceskatelevize.cz/video/v1/playlist-vod/v1/stream-data/media/external/{idec}"
        f"?canPlayDrm=false&quality=web&streamType=dash&origin=ivysilani&client=ivysilaniweb&clientVersion=0.11.1"
    )
    
    resp = requests.get(api_url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://player.ceskatelevize.cz/',
        'x-geoip-country': 'cz',
        'x-device': 'web',
    }, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    
    stream = data['streams'][0]
    return {
        'title': data.get('title', f'video_{idec}'),
        'duration': data.get('duration', 0),
        'url': stream['url'],
        'subtitles': stream.get('subtitles', []),
    }


def get_manifest_url(cdn_url: str) -> str:
    """Resolve CDN URL to get actual manifest URL."""
    resp = requests.get(cdn_url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    }, allow_redirects=True, timeout=30)
    
    match = re.search(r'<Location>([^<]+)</Location>', resp.text)
    if match:
        return match.group(1)
    return resp.url


def download_video(manifest_url: str, output: str, subtitles: list = None) -> bool:
    """Download video using yt-dlp."""
    cmd = [
        'yt-dlp',
        '--no-check-certificate',
        '-f', 'bestvideo+bestaudio/best',
        '--merge-output-format', 'mp4',
        '--no-warnings',
        '-o', output,
        manifest_url
    ]
    
    print(f"  Downloading: {os.path.basename(output)}")
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    if result.returncode != 0:
        # Check if files were downloaded but merge failed
        base = output.rsplit('.', 1)[0]
        video_file = None
        audio_file = None
        
        for f in Path(output).parent.glob(f"{Path(output).stem}.*"):
            if '.f1001' in f.name or '.f1002' in f.name:
                if f.suffix == '.mp4':
                    video_file = f
                elif f.suffix == '.m4a':
                    audio_file = f
        
        if video_file and audio_file:
            print(f"  Merge failed, retrying with ffmpeg...")
            merge_cmd = [
                'ffmpeg', '-y',
                '-i', str(video_file),
                '-i', str(audio_file),
                '-c', 'copy',
                '-movflags', '+faststart',
                output
            ]
            merge_result = subprocess.run(merge_cmd, capture_output=True, text=True)
            if merge_result.returncode == 0:
                video_file.unlink()
                audio_file.unlink()
                print(f"  ✓ Merged successfully")
            else:
                print(f"  ✗ Merge failed: {merge_result.stderr[:200]}")
                return False
        else:
            print(f"  ✗ Download failed: {result.stderr[:200]}")
            return False
    
    # Download subtitles
    if subtitles and os.path.exists(output):
        for sub in subtitles:
            lang = sub.get('language', 'cs')
            for f in sub.get('files', []):
                if f.get('format') == 'vtt':
                    sub_url = f['url']
                    sub_file = output.rsplit('.', 1)[0] + f'.{lang}.vtt'
                    try:
                        resp = requests.get(sub_url, timeout=30)
                        with open(sub_file, 'wb') as sf:
                            sf.write(resp.content)
                        print(f"  ✓ Subtitles: {os.path.basename(sub_file)}")
                    except Exception as e:
                        print(f"  ⚠ Subtitles failed: {e}")
                    break
    
    return os.path.exists(output)


def sanitize_filename(name: str) -> str:
    """Make filename safe for filesystem."""
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    name = re.sub(r'\s+', ' ', name).strip()
    return name[:200]


def main():
    parser = argparse.ArgumentParser(
        description='Batch download videos from Česká televize'
    )
    parser.add_argument('--json', '-j', default='wanted_ct.json',
                        help='JSON file with video list (default: wanted_ct.json)')
    parser.add_argument('--output-dir', '-o', default='.',
                        help='Output directory (default: current dir)')
    parser.add_argument('--skip-existing', '-s', action='store_true', default=True,
                        help='Skip already downloaded files (default: True)')
    
    args = parser.parse_args()
    
    # Load JSON
    json_path = args.json
    if not os.path.exists(json_path):
        print(f"Error: JSON file not found: {json_path}")
        sys.exit(1)
    
    with open(json_path, 'r') as f:
        data = json.load(f)
    
    videos = data.get('videos', [])
    if not videos:
        print("No videos found in JSON")
        sys.exit(1)
    
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"{'='*60}")
    print(f"CT Batch Downloader")
    print(f"{'='*60}")
    print(f"Videos: {len(videos)}")
    print(f"Output: {output_dir.absolute()}")
    print(f"{'='*60}\n")
    
    success = 0
    failed = 0
    skipped = 0
    
    for i, video in enumerate(videos, 1):
        title = video.get('title', f"video_{i}")
        idec = video.get('idec')
        url = video.get('url', '')
        
        print(f"[{i}/{len(videos)}] {title}")
        
        if not idec:
            print(f"  ✗ No IDEC found, skipping")
            failed += 1
            continue
        
        safe_title = sanitize_filename(title)
        output_file = output_dir / f"{safe_title}.mp4"
        
        if args.skip_existing and output_file.exists():
            size_mb = output_file.stat().st_size / (1024 * 1024)
            print(f"  ✓ Already exists ({size_mb:.1f} MB)")
            skipped += 1
            continue
        
        try:
            stream_info = get_stream_url(idec)
            manifest_url = get_manifest_url(stream_info['url'])
            
            duration_min = stream_info['duration'] // 60
            print(f"  Duration: {duration_min}m, IDEC: {idec}")
            
            if download_video(manifest_url, str(output_file), stream_info['subtitles']):
                size_mb = output_file.stat().st_size / (1024 * 1024)
                print(f"  ✓ Done ({size_mb:.1f} MB)")
                success += 1
            else:
                failed += 1
        except Exception as e:
            print(f"  ✗ Error: {e}")
            failed += 1
    
    print(f"\n{'='*60}")
    print(f"Complete: {success} downloaded, {skipped} skipped, {failed} failed")
    print(f"{'='*60}")


if __name__ == '__main__':
    main()
