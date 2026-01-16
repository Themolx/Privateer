#!/usr/bin/env python3
"""
OnePlay Downloader - Download series and movies from oneplay.cz
Handles DRM-protected content using Widevine decryption.
Output is organized for Jellyfin/Plex media servers.

Requirements:
    pip install playwright requests
    python -m playwright install chromium
    
System dependencies:
    - mp4decrypt (from bento4): brew install bento4 / apt install bento4
    - ffmpeg: brew install ffmpeg / apt install ffmpeg
    - yt-dlp: pip install yt-dlp / brew install yt-dlp

Usage:
    python oneplay_dl.py --url "https://www.oneplay.cz/porad/33-comeback" --token "YOUR_BEARER_TOKEN"
    python oneplay_dl.py --url "https://www.oneplay.cz/porad/33-comeback/epizoda/271" --token "YOUR_BEARER_TOKEN"
"""

import argparse
import asyncio
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, List

import requests

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("ERROR: playwright not installed")
    print("Run: pip install playwright && python -m playwright install chromium")
    sys.exit(1)


@dataclass
class Episode:
    """Episode metadata"""
    id: str
    title: str
    url: str
    series: str = ""
    season: int = 1
    episode_num: int = 0


@dataclass
class StreamInfo:
    """Stream information including DRM details"""
    mpd_url: str
    license_url: str
    drm_header_name: str
    drm_header_value: str
    subtitles: list


@dataclass
class DecryptionKey:
    """Widevine decryption key"""
    key_id: str
    key: str


class RemoteCDM:
    """Client for Remote CDM API to get Widevine keys"""
    
    def __init__(self, host: str = "https://cdrm-project.com/remotecdm/widevine",
                 secret: str = "CDRM", device_name: str = "public"):
        self.host = host
        self.secret = secret
        self.device_name = device_name
        self.session_id = None
    
    def _headers(self):
        return {"X-Secret-Key": self.secret}
    
    def open_session(self) -> str:
        """Open a CDM session"""
        resp = requests.get(
            f"{self.host}/{self.device_name}/open",
            headers=self._headers(),
            timeout=30
        )
        resp.raise_for_status()
        self.session_id = resp.json()['data']['session_id']
        return self.session_id
    
    def get_challenge(self, pssh: str) -> bytes:
        """Get license challenge for given PSSH"""
        if not self.session_id:
            self.open_session()
        
        resp = requests.post(
            f"{self.host}/{self.device_name}/get_license_challenge/STREAMING",
            json={"session_id": self.session_id, "init_data": pssh},
            headers=self._headers(),
            timeout=30
        )
        resp.raise_for_status()
        challenge_b64 = resp.json()['data']['challenge_b64']
        return base64.b64decode(challenge_b64)
    
    def parse_license(self, license_data: bytes) -> List[DecryptionKey]:
        """Parse license response and get keys"""
        if not self.session_id:
            raise RuntimeError("No active session")
        
        license_b64 = base64.b64encode(license_data).decode()
        
        resp = requests.post(
            f"{self.host}/{self.device_name}/parse_license",
            json={"session_id": self.session_id, "license_message": license_b64},
            headers=self._headers(),
            timeout=30
        )
        resp.raise_for_status()
        
        resp = requests.post(
            f"{self.host}/{self.device_name}/get_keys/ALL",
            json={"session_id": self.session_id},
            headers=self._headers(),
            timeout=30
        )
        resp.raise_for_status()
        
        keys = []
        for key_data in resp.json()['data']['keys']:
            if key_data['type'] == 'CONTENT':
                keys.append(DecryptionKey(
                    key_id=key_data['key_id'],
                    key=key_data['key']
                ))
        return keys
    
    def close_session(self):
        """Close the CDM session"""
        if self.session_id:
            try:
                requests.get(
                    f"{self.host}/{self.device_name}/close/{self.session_id}",
                    headers=self._headers(),
                    timeout=10
                )
            except:
                pass
            self.session_id = None


class OnePlayDownloader:
    """Main downloader class for OnePlay content"""
    
    def __init__(self, bearer_token: str, output_dir: str = "./downloads", crop_43: bool = False):
        self.bearer_token = bearer_token
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.crop_43 = crop_43
        self.cdm = RemoteCDM()
    
    @staticmethod
    def sanitize_filename(name: str) -> str:
        """Make filename safe for filesystem - Jellyfin compatible"""
        # Normalize unicode
        name = unicodedata.normalize('NFKD', name)
        # Remove/replace unsafe characters
        name = re.sub(r'[<>:"/\\|?*]', '', name)
        name = re.sub(r'[\x00-\x1f]', '', name)
        name = re.sub(r'\s+', ' ', name).strip()
        # Remove trailing dots/spaces (Windows issue)
        name = name.rstrip('. ')
        return name[:200]
    
    @staticmethod
    def clean_series_name(name: str) -> str:
        """Clean series name from page title"""
        # Remove common suffixes
        name = re.sub(r'\s*[-–|]\s*Sledujte.*$', '', name, flags=re.IGNORECASE)
        name = re.sub(r'\s*[-–|]\s*Oneplay.*$', '', name, flags=re.IGNORECASE)
        name = re.sub(r'\s*\|.*$', '', name)
        return name.strip()
    
    def get_jellyfin_path(self, episode: Episode) -> Path:
        """
        Get Jellyfin-compatible output path.
        Structure: {output_dir}/{Series}/Season {XX}/{Series} - S{XX}E{XX} - {Title}.mp4
        """
        series_name = self.sanitize_filename(episode.series)
        season_folder = f"Season {episode.season:02d}"
        
        # Jellyfin naming: "Show Name - SXXEXX - Episode Title.mp4"
        if episode.episode_num > 0:
            filename = f"{series_name} - S{episode.season:02d}E{episode.episode_num:02d} - {self.sanitize_filename(episode.title)}.mp4"
        else:
            # For movies or specials without episode number
            filename = f"{self.sanitize_filename(episode.title)}.mp4"
        
        # Create directory structure
        if episode.season > 0:
            output_path = self.output_dir / series_name / season_folder / filename
        else:
            # Movies go directly in output dir
            output_path = self.output_dir / "Movies" / filename
        
        output_path.parent.mkdir(parents=True, exist_ok=True)
        return output_path
    
    async def get_episodes_from_show(self, show_url: str) -> List[Episode]:
        """Crawl show page to get all episode URLs"""
        episodes = []
        
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context()
            
            await context.add_cookies([{
                'name': 'bearerToken',
                'value': self.bearer_token,
                'domain': '.oneplay.cz',
                'path': '/'
            }])
            
            page = await context.new_page()
            print(f"Loading show page: {show_url}")
            await page.goto(show_url)
            await page.wait_for_timeout(3000)
            
            # Get show title
            show_title = await page.title()
            show_title = self.clean_series_name(show_title)
            print(f"Series: {show_title}")
            
            # Scroll to load all episodes
            print("Scrolling to load all episodes...")
            for _ in range(15):
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await page.wait_for_timeout(500)
            
            content = await page.content()
            
            # Get show slug from URL
            show_slug_match = re.search(r'/porad/(\d+-[^/]+)', show_url)
            show_slug = show_slug_match.group(1) if show_slug_match else ""
            
            # Find all episode links for this show
            episode_pattern = rf'href="((?:https://www\.oneplay\.cz)?/porad/{re.escape(show_slug)}/epizoda/(\d+)-([^"]+))"'
            episode_links = re.findall(episode_pattern, content)
            
            seen = set()
            for full_url, ep_id, slug in episode_links:
                if ep_id not in seen:
                    seen.add(ep_id)
                    
                    # Parse episode info from slug
                    # Format: "271-16-dil-heavy-christmas" -> episode 16, title "Heavy Christmas"
                    title_parts = slug.split('-')
                    
                    # Find episode number (X-dil pattern)
                    ep_num = 0
                    title_start = 0
                    for i, part in enumerate(title_parts):
                        if part == 'dil' and i > 0:
                            try:
                                ep_num = int(title_parts[i-1])
                                title_start = i + 1
                            except ValueError:
                                pass
                            break
                    
                    # Build title from remaining parts
                    if title_start > 0 and title_start < len(title_parts):
                        title = ' '.join(title_parts[title_start:]).title()
                    else:
                        title = slug.replace('-', ' ').title()
                    
                    # Find season number
                    season = 1
                    season_match = re.search(r'(\d+)-serie', slug)
                    if season_match:
                        season = int(season_match.group(1))
                    
                    # Ensure URL is absolute
                    if full_url.startswith('/'):
                        full_url = f"https://www.oneplay.cz{full_url}"
                    
                    episodes.append(Episode(
                        id=ep_id,
                        title=title,
                        url=full_url,
                        series=show_title,
                        season=season,
                        episode_num=ep_num
                    ))
            
            await browser.close()
        
        # Sort by season and episode number
        episodes.sort(key=lambda e: (e.season, e.episode_num))
        return episodes
    
    async def get_stream_info(self, episode_url: str) -> Optional[StreamInfo]:
        """Get stream URL and DRM info for an episode or film"""
        stream_info = None
        
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context()
            
            await context.add_cookies([{
                'name': 'bearerToken',
                'value': self.bearer_token,
                'domain': '.oneplay.cz',
                'path': '/'
            }])
            
            page = await context.new_page()
            
            # Set localStorage auth token
            await page.goto('https://www.oneplay.cz', wait_until='domcontentloaded')
            await page.evaluate(f'''() => {{
                localStorage.setItem('lastAuthToken', '{self.bearer_token}');
            }}''')
            
            async def handle_ws(ws):
                def on_recv(payload):
                    nonlocal stream_info
                    if 'content.play' in str(payload) and 'VideoAsset' in str(payload):
                        try:
                            data = json.loads(payload)
                            resp = data.get('response', {}).get('data', {})
                            media = resp.get('media', {})
                            stream = media.get('stream', {})
                            assets = stream.get('assets', [])
                            
                            for asset in assets:
                                if asset.get('protocol') == 'dash':
                                    mpd_url = asset.get('src')
                                    subtitles = []
                                    
                                    for sub in asset.get('subtitles', []):
                                        loc = sub.get('location', {})
                                        if loc.get('schema') == 'ExternalTrackLocation':
                                            subtitles.append({
                                                'url': loc.get('url'),
                                                'lang': sub.get('language', {}).get('code', 'cs')
                                            })
                                    
                                    for drm in asset.get('drm', []):
                                        if drm.get('schema') == 'WidevineAcquisition':
                                            auth = drm.get('drmAuthorization', {})
                                            stream_info = StreamInfo(
                                                mpd_url=mpd_url,
                                                license_url=drm.get('licenseAcquisitionURL'),
                                                drm_header_name=auth.get('name'),
                                                drm_header_value=auth.get('value'),
                                                subtitles=subtitles
                                            )
                                            break
                                    break
                        except Exception as e:
                            print(f"    Warning: Error parsing stream info: {e}")
                
                ws.on("framereceived", on_recv)
            
            page.on("websocket", handle_ws)
            
            # For films, try navigating directly to #play URL
            if '/film/' in episode_url:
                play_url = episode_url.rstrip('#') + '#play'
                await page.goto(play_url)
            else:
                await page.goto(episode_url)
            
            await page.wait_for_timeout(5000)
            
            # Try to click play button if stream info not received yet
            if not stream_info:
                # Extensive list of play button selectors
                play_selectors = [
                    # Films often use an anchor with #play or specific class
                    'a[href$="#play"]',
                    'a.e-action-link[href*="play"]',
                    '[data-testid="play-button"]',
                    'button:has-text("Přehrát")',
                    'button:has-text("Prehrat")',
                    'a:has-text("Od začátku")',
                    'a:has-text("Přehrát")',
                    'button.e-primary-action-button',
                    '.e-content-detail-header button',
                    'button:has-text("Sledovat")',
                    # Fallback generic play icons
                    '.icon-play',
                    '[aria-label="Přehrát"]'
                ]
                
                print("    Trying to trigger playback...")
                for selector in play_selectors:
                    try:
                        # Check visibility first
                        el = await page.query_selector(selector)
                        if el and await el.is_visible():
                            print(f"      Clicking: {selector}")
                            await el.click(force=True, timeout=2000)
                            # Wait a bit to see if WS fires
                            await page.wait_for_timeout(3000)
                            if stream_info:
                                print("      ✓ Playback started")
                                break
                    except Exception as e:
                        # Ignore click errors, try next
                        continue
            
            # If still no stream info, try scrolling and waiting
            if not stream_info:
                await page.wait_for_timeout(3000)
            
            await browser.close()
        
        return stream_info
    
    def get_pssh_from_mpd(self, mpd_url: str) -> Optional[str]:
        """Extract Widevine PSSH from MPD manifest"""
        resp = requests.get(mpd_url, verify=False, timeout=30)
        resp.raise_for_status()
        
        pssh_matches = re.findall(r'<cenc:pssh[^>]*>([^<]+)</cenc:pssh>', resp.text)
        
        for pssh in pssh_matches:
            try:
                decoded = base64.b64decode(pssh)
                if b'\xed\xef\x8b\xa9' in decoded:  # Widevine system ID
                    return pssh
            except:
                pass
        
        return None
    
    def get_decryption_keys(self, stream_info: StreamInfo) -> List[DecryptionKey]:
        """Get Widevine decryption keys for the stream"""
        pssh = self.get_pssh_from_mpd(stream_info.mpd_url)
        if not pssh:
            raise RuntimeError("Could not find Widevine PSSH in MPD")
        
        print(f"    PSSH: {pssh[:50]}...")
        
        self.cdm.open_session()
        challenge = self.cdm.get_challenge(pssh)
        print(f"    Challenge: {len(challenge)} bytes")
        
        resp = requests.post(
            stream_info.license_url,
            data=challenge,
            headers={
                stream_info.drm_header_name: stream_info.drm_header_value,
                'Content-Type': 'application/octet-stream'
            },
            timeout=30
        )
        resp.raise_for_status()
        print(f"    License: {len(resp.content)} bytes")
        
        keys = self.cdm.parse_license(resp.content)
        self.cdm.close_session()
        
        return keys
    
    async def _download_stream_concurrent(self, mpd_url: str, output_path: Path, format_selector: str, stream_type: str):
        """Helper to download a single stream concurrently"""
        print(f"    Downloading {stream_type}...")
        
        yt_dlp_cmd = shutil.which('yt-dlp')
        cmd = [
            yt_dlp_cmd,
            '--allow-unplayable-formats',
            '-f', format_selector,
            '--no-check-certificate',
            '--no-warnings',
            '--progress',
            '-o', str(output_path),
            mpd_url
        ]
        
        # Add aria2c if available
        if shutil.which('aria2c'):
            cmd.extend(['--external-downloader', 'aria2c'])
            cmd.extend(['--external-downloader-args', '-x 16 -k 1M'])
        
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        stdout, stderr = await process.communicate()
        
        if process.returncode != 0:
            raise RuntimeError(f"{stream_type} download failed: {stderr.decode()[:300]}")

    async def download_encrypted(self, mpd_url: str, output_path: Path) -> tuple:
        """Download encrypted video and audio streams concurrently"""
        video_path = output_path.with_suffix('.enc_video.mp4')
        audio_path = output_path.with_suffix('.enc_audio.m4a')
        
        yt_dlp_cmd = shutil.which('yt-dlp')
        if not yt_dlp_cmd:
            raise RuntimeError("yt-dlp not found. Install with: pip install yt-dlp")
        
        # Run downloads concurrently
        await asyncio.gather(
            self._download_stream_concurrent(mpd_url, video_path, 'bestvideo', 'video'),
            self._download_stream_concurrent(mpd_url, audio_path, 'bestaudio', 'audio')
        )
        
        # Find actual downloaded files
        video_files = list(output_path.parent.glob(f"{output_path.stem}.enc_video*"))
        audio_files = list(output_path.parent.glob(f"{output_path.stem}.enc_audio*"))
        
        if video_files:
            video_path = video_files[0]
        if audio_files:
            audio_path = audio_files[0]
        
        if not video_path.exists():
            raise RuntimeError(f"Video file not found after download")
        if not audio_path.exists():
            raise RuntimeError(f"Audio file not found after download")
        
        return video_path, audio_path
    
    def decrypt_file(self, input_path: Path, output_path: Path, keys: List[DecryptionKey]):
        """Decrypt a file using mp4decrypt"""
        mp4decrypt = shutil.which('mp4decrypt')
        if not mp4decrypt:
            raise RuntimeError("mp4decrypt not found. Install bento4.")
        
        key_args = []
        for key in keys:
            key_args.extend(['--key', f"{key.key_id}:{key.key}"])
        
        cmd = [mp4decrypt] + key_args + [str(input_path), str(output_path)]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"Decryption failed: {result.stderr[:200]}")
    
    def merge_av(self, video_path: Path, audio_path: Path, output_path: Path):
        """Merge video and audio with ffmpeg, optionally cropping 16:9 to 4:3"""
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg:
            raise RuntimeError("ffmpeg not found")
        
        cmd = [ffmpeg, '-y', '-i', str(video_path), '-i', str(audio_path)]
        
        if self.crop_43:
            print("    Cropping to 4:3 (Re-encoding video)...")
            # Crop 1920x1080 to 1440x1080 (240px from each side)
            # Using libx264 high quality CRF 18
            cmd.extend([
                '-vf', 'crop=1440:1080:240:0',
                '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
                '-c:a', 'copy'
            ])
        else:
            cmd.extend(['-c', 'copy'])
            
        cmd.extend([
            '-shortest',
            '-movflags', '+faststart',
            str(output_path)
        ])
        
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"Merge failed: {result.stderr[:200]}")
    
    def download_subtitles(self, subtitles: list, output_path: Path):
        """Download subtitle files with Jellyfin naming"""
        for sub in subtitles:
            sub_url = sub['url']
            lang = sub.get('lang', 'cs')
            
            # Jellyfin subtitle naming: "Movie.en.srt" or "Movie.cs.vtt"
            sub_path = output_path.with_suffix(f'.{lang}.vtt')
            
            try:
                resp = requests.get(sub_url, verify=False, timeout=30)
                if resp.status_code == 200:
                    sub_path.write_bytes(resp.content)
                    print(f"    Subtitles: {sub_path.name}")
            except Exception as e:
                print(f"    Warning: Failed to download subtitles: {e}")
    
    async def download_episode(self, episode: Episode) -> bool:
        """Download a single episode"""
        print(f"\n{'='*70}")
        print(f"Series: {episode.series}")
        print(f"Episode: S{episode.season:02d}E{episode.episode_num:02d} - {episode.title}")
        print(f"URL: {episode.url}")
        print(f"{'='*70}")
        
        output_path = self.get_jellyfin_path(episode)
        print(f"Output: {output_path}")
        
        if output_path.exists():
            print(f"  ✓ Already exists, skipping")
            return True
        
        temp_dir = self.output_dir / ".temp"
        temp_dir.mkdir(exist_ok=True)
        temp_base = temp_dir / f"temp_{episode.id}"
        
        try:
            # Step 1: Get stream info
            print("  [1/5] Getting stream info...")
            stream_info = await self.get_stream_info(episode.url)
            if not stream_info:
                print("  ✗ Could not get stream info")
                return False
            
            # Step 2: Get decryption keys
            print("  [2/5] Getting decryption keys...")
            keys = self.get_decryption_keys(stream_info)
            if not keys:
                print("  ✗ Could not get decryption keys")
                return False
            
            for key in keys:
                print(f"    Key: {key.key_id}:{key.key}")
            
            # Step 3: Download encrypted streams
            print("  [3/5] Downloading encrypted streams...")
            enc_video, enc_audio = await self.download_encrypted(stream_info.mpd_url, temp_base)
            
            # Step 4: Decrypt
            print("  [4/5] Decrypting...")
            dec_video = temp_base.with_suffix('.dec_video.mp4')
            dec_audio = temp_base.with_suffix('.dec_audio.m4a')
            
            self.decrypt_file(enc_video, dec_video, keys)
            self.decrypt_file(enc_audio, dec_audio, keys)
            
            # Step 5: Merge
            print("  [5/5] Merging video and audio...")
            self.merge_av(dec_video, dec_audio, output_path)
            
            # Download subtitles
            if stream_info.subtitles:
                self.download_subtitles(stream_info.subtitles, output_path)
            
            # Cleanup temp files
            for f in temp_dir.glob(f"temp_{episode.id}*"):
                try:
                    f.unlink()
                except:
                    pass
            
            file_size = output_path.stat().st_size / (1024 * 1024 * 1024)
            print(f"  ✓ Saved: {output_path.name} ({file_size:.2f} GB)")
            return True
            
        except Exception as e:
            print(f"  ✗ ERROR: {e}")
            return False
    
    async def download_show(self, show_url: str):
        """Download all episodes from a show"""
        print(f"\n{'#'*70}")
        print(f"# OnePlay Downloader")
        print(f"# Show URL: {show_url}")
        print(f"{'#'*70}")
        
        episodes = await self.get_episodes_from_show(show_url)
        
        if not episodes:
            print("\nNo episodes found!")
            return
        
        print(f"\nFound {len(episodes)} episodes:")
        for ep in episodes:
            print(f"  S{ep.season:02d}E{ep.episode_num:02d}: {ep.title}")
        
        print(f"\nOutput directory: {self.output_dir}")
        print(f"Starting download...\n")
        
        success = 0
        failed = 0
        skipped = 0
        
        for i, ep in enumerate(episodes, 1):
            print(f"\n[{i}/{len(episodes)}]", end="")
            result = await self.download_episode(ep)
            if result:
                output_path = self.get_jellyfin_path(ep)
                if output_path.exists():
                    success += 1
            else:
                failed += 1
        
        print(f"\n{'#'*70}")
        print(f"# Download Complete!")
        print(f"# Success: {success}")
        print(f"# Failed: {failed}")
        print(f"# Output: {self.output_dir}")
        print(f"{'#'*70}")
    
    async def download_single(self, url: str):
        """Download a single episode or movie"""
        ep_match = re.search(r'/epizoda/(\d+)(?:-(.+?))?(?:\?|$)', url)
        film_match = re.search(r'/film/(\d+)(?:-(.+?))?(?:\?|$)', url)
        
        if ep_match:
            ep_id = ep_match.group(1)
            slug = ep_match.group(2) or ""
            
            # Parse title and episode number
            title_parts = slug.split('-') if slug else []
            ep_num = 0
            title = slug.replace('-', ' ').title() if slug else f"Episode {ep_id}"
            
            for i, part in enumerate(title_parts):
                if part == 'dil' and i > 0:
                    try:
                        ep_num = int(title_parts[i-1])
                        title = ' '.join(title_parts[i+1:]).title() if i+1 < len(title_parts) else title
                    except ValueError:
                        pass
                    break
            
            # Get series name from URL
            series_match = re.search(r'/porad/\d+-([^/]+)/', url)
            series = series_match.group(1).replace('-', ' ').title() if series_match else "Unknown Series"
            
            episode = Episode(
                id=ep_id,
                title=title,
                url=url,
                series=series,
                season=1,
                episode_num=ep_num
            )
        elif film_match:
            film_id = film_match.group(1)
            slug = film_match.group(2) or ""
            title = slug.replace('-', ' ').title() if slug else f"Film {film_id}"
            
            episode = Episode(
                id=film_id,
                title=title,
                url=url,
                series="",
                season=0,
                episode_num=0
            )
        else:
            print(f"Could not parse URL: {url}")
            return
        
        await self.download_episode(episode)


def check_dependencies():
    """Check if all required tools are installed"""
    missing = []
    
    if not shutil.which('yt-dlp'):
        missing.append("yt-dlp (pip install yt-dlp)")
    
    if not shutil.which('mp4decrypt'):
        missing.append("mp4decrypt (brew install bento4 / apt install bento4)")
    
    if not shutil.which('ffmpeg'):
        missing.append("ffmpeg (brew install ffmpeg / apt install ffmpeg)")
    
    if missing:
        print("ERROR: Missing required tools:")
        for tool in missing:
            print(f"  - {tool}")
        sys.exit(1)

    if not shutil.which('aria2c'):
        print("WARNING: aria2c not found. Downloads will be slower.")
        print("         Install with: brew install aria2 / apt install aria2")


def main():
    parser = argparse.ArgumentParser(
        description='Download videos from OnePlay.cz with Jellyfin-compatible naming',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Output Structure (Jellyfin/Plex compatible):
  {output}/
    {Series Name}/
      Season 01/
        {Series Name} - S01E01 - {Episode Title}.mp4
        {Series Name} - S01E01 - {Episode Title}.cs.vtt
      Season 02/
        ...

Examples:
  # Download entire series
  python oneplay_dl.py -u "https://www.oneplay.cz/porad/33-comeback" -t "YOUR_TOKEN"
  
  # Download single episode
  python oneplay_dl.py -u "https://www.oneplay.cz/porad/33-comeback/epizoda/271-16-dil" -t "YOUR_TOKEN"
  
  # Custom output directory
  python oneplay_dl.py -u "https://www.oneplay.cz/porad/33-comeback" -t "YOUR_TOKEN" -o "/mnt/media/TV"

Get your bearer token:
  1. Login to oneplay.cz in browser
  2. Open Developer Tools (F12) -> Application -> Cookies
  3. Copy the 'bearerToken' value
        """
    )
    
    parser.add_argument('--url', '-u', required=True,
                       help='URL of show, episode, or movie')
    parser.add_argument('--token', '-t', required=True,
                       help='Bearer token from oneplay.cz cookies')
    parser.add_argument('--output', '-o', default='./downloads',
                       help='Output directory (default: ./downloads)')
    parser.add_argument('--crop-43', action='store_true',
                       help='Crop 16:9 pillarboxed video to 4:3 (re-encodes video)')
    
    args = parser.parse_args()
    
    # Check dependencies
    check_dependencies()
    
    # Suppress SSL warnings
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    
    downloader = OnePlayDownloader(args.token, args.output, args.crop_43)
    
    # Determine if it's a show page or single video
    if '/epizoda/' in args.url or '/film/' in args.url:
        asyncio.run(downloader.download_single(args.url))
    else:
        asyncio.run(downloader.download_show(args.url))


if __name__ == '__main__':
    main()
