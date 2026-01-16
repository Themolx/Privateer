#!/usr/bin/env python3
"""
NFB Video Downloader
Downloads videos from nfb.ca in the best available quality (up to 1080p).

Usage:
    python nfb_download.py <url>                    # Download single video
    python nfb_download.py --file <urls.txt>        # Download from file (one URL per line)
    python nfb_download.py --file <urls.txt> --max 10  # Download first 10 from file
"""

import subprocess
import sys
import argparse
import os
from pathlib import Path


def download_video(url: str, output_dir: str = ".", quality: str = "1080") -> bool:
    """
    Download a video from NFB in the specified quality.
    
    Args:
        url: NFB film URL (e.g., https://www.nfb.ca/film/big_snit/)
        output_dir: Directory to save the video
        quality: Target quality (1080, 720, 480, 360)
    
    Returns:
        True if download succeeded, False otherwise
    """
    # Extract film name from URL for filename
    film_slug = url.rstrip('/').split('/')[-1]
    output_template = os.path.join(output_dir, f"{film_slug}_%(height)sp.%(ext)s")
    
    # Build yt-dlp command
    cmd = [
        "yt-dlp",
        "-f", f"bestvideo[height<={quality}]+bestaudio/best[height<={quality}]",
        "-o", output_template,
        "--no-overwrites",  # Skip if file exists
        url
    ]
    
    print(f"📥 Downloading: {film_slug}")
    
    try:
        result = subprocess.run(cmd, capture_output=False, text=True)
        if result.returncode == 0:
            print(f"✅ Downloaded: {film_slug}")
            return True
        else:
            print(f"❌ Failed: {film_slug}")
            return False
    except FileNotFoundError:
        print("❌ Error: yt-dlp not found. Install with: brew install yt-dlp")
        return False
    except Exception as e:
        print(f"❌ Error downloading {film_slug}: {e}")
        return False


def download_from_file(filepath: str, output_dir: str = ".", quality: str = "1080", max_downloads: int = None) -> tuple:
    """
    Download multiple videos from a file containing URLs (one per line).
    
    Args:
        filepath: Path to file with URLs
        output_dir: Directory to save videos
        quality: Target quality
        max_downloads: Maximum number of videos to download (None = all)
    
    Returns:
        Tuple of (successful_count, failed_count)
    """
    with open(filepath, 'r') as f:
        urls = [line.strip() for line in f if line.strip() and not line.startswith('#')]
    
    if max_downloads:
        urls = urls[:max_downloads]
    
    print(f"📋 Found {len(urls)} URLs to download")
    
    success = 0
    failed = 0
    
    for i, url in enumerate(urls, 1):
        print(f"\n[{i}/{len(urls)}] ", end="")
        if download_video(url, output_dir, quality):
            success += 1
        else:
            failed += 1
    
    print(f"\n📊 Complete: {success} downloaded, {failed} failed")
    return success, failed


def main():
    parser = argparse.ArgumentParser(description="Download videos from NFB (National Film Board of Canada)")
    parser.add_argument("url", nargs="?", help="Single NFB film URL to download")
    parser.add_argument("--file", "-f", help="File containing URLs (one per line)")
    parser.add_argument("--output", "-o", default=".", help="Output directory (default: current directory)")
    parser.add_argument("--quality", "-q", default="1080", choices=["360", "480", "720", "1080"],
                        help="Maximum video quality (default: 1080)")
    parser.add_argument("--max", "-m", type=int, help="Maximum number of videos to download from file")
    
    args = parser.parse_args()
    
    # Create output directory if needed
    os.makedirs(args.output, exist_ok=True)
    
    if args.file:
        download_from_file(args.file, args.output, args.quality, args.max)
    elif args.url:
        download_video(args.url, args.output, args.quality)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
