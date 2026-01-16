#!/usr/bin/env python3
"""
Artycok.tv Downloader - Batch Video Downloader with Resume Support

Downloads videos from artycok.tv using HLS streams via CESNET CDN.
Supports batch processing, quality selection, and resumable downloads.

Usage:
    python artycok_dl.py URL                            # Download single video
    python artycok_dl.py --json urls.json               # Batch from JSON file
    python artycok_dl.py URL --quality 720p             # Force quality
    python artycok_dl.py URL --dry-run                  # Parse only, no download
    
Examples:
    python artycok_dl.py https://artycok.tv/cs/post/route
    python artycok_dl.py --json artycok_videos.json --output-dir ./downloads
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, List, Any
from urllib.parse import urlparse

import requests

# ============================================================================
# CONFIGURATION
# ============================================================================

# Get script directory for default output
SCRIPT_DIR = Path(__file__).parent.resolve()
DEFAULT_OUTPUT_DIR = str(SCRIPT_DIR / "artycok_downloads")

DEFAULT_QUALITY = "1080p"
STATE_FILE_NAME = ".artycok_state.json"
MAX_RETRIES = 3
RETRY_DELAY = 5  # seconds

# Duration threshold for short vs feature classification (in minutes)
SHORT_FILM_MAX_DURATION = 40  # Films <= 40 minutes are considered shorts

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'cs,en-US;q=0.7,en;q=0.3',
}

# Quality preference order
QUALITY_ORDER = ['1080p', '720p', '576p', '480p', '360p']

# ============================================================================
# TERMINAL OUTPUT FORMATTING
# ============================================================================

class Colors:
    """ANSI color codes for terminal output."""
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    BOLD = '\033[1m'
    DIM = '\033[2m'
    RESET = '\033[0m'


def print_header(text: str):
    """Print a header line."""
    print(f"\n{Colors.BOLD}{Colors.CYAN}{'═' * 60}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.CYAN}{text.center(60)}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.CYAN}{'═' * 60}{Colors.RESET}\n")


def print_success(text: str):
    print(f"  {Colors.GREEN}✓{Colors.RESET} {text}")


def print_error(text: str):
    print(f"  {Colors.RED}✗{Colors.RESET} {text}")


def print_warning(text: str):
    print(f"  {Colors.YELLOW}⚠{Colors.RESET} {text}")


def print_info(text: str):
    print(f"  {Colors.BLUE}ℹ{Colors.RESET} {text}")


def print_progress(current: int, total: int, title: str):
    """Print progress indicator."""
    pct = (current / total * 100) if total > 0 else 0
    bar_width = 30
    filled = int(bar_width * current / total) if total > 0 else 0
    bar = '█' * filled + '░' * (bar_width - filled)
    print(f"\n{Colors.BOLD}[{current}/{total}]{Colors.RESET} {bar} {pct:.0f}%")
    print(f"  {Colors.CYAN}{title[:50]}...{Colors.RESET}" if len(title) > 50 else f"  {Colors.CYAN}{title}{Colors.RESET}")


# ============================================================================
# STATE MANAGEMENT (for resumability)
# ============================================================================

class StateManager:
    """Manages download state for resumability."""
    
    def __init__(self, output_dir: Path):
        self.state_file = output_dir / STATE_FILE_NAME
        self.state = self._load_state()
    
    def _load_state(self) -> Dict:
        """Load state from file or create new."""
        if self.state_file.exists():
            try:
                with open(self.state_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                pass
        return {
            "completed": [],
            "failed": {},
            "in_progress": None,
            "last_updated": None
        }
    
    def save(self):
        """Save current state to file."""
        self.state["last_updated"] = datetime.now().isoformat()
        with open(self.state_file, 'w', encoding='utf-8') as f:
            json.dump(self.state, f, indent=2, ensure_ascii=False)
    
    def is_completed(self, url: str) -> bool:
        """Check if URL was already downloaded."""
        return url in self.state["completed"]
    
    def mark_completed(self, url: str):
        """Mark URL as successfully downloaded."""
        if url not in self.state["completed"]:
            self.state["completed"].append(url)
        if url in self.state["failed"]:
            del self.state["failed"][url]
        self.state["in_progress"] = None
        self.save()
    
    def mark_failed(self, url: str, error: str):
        """Mark URL as failed with error message."""
        self.state["failed"][url] = {
            "error": error,
            "attempts": self.state["failed"].get(url, {}).get("attempts", 0) + 1,
            "last_attempt": datetime.now().isoformat()
        }
        self.state["in_progress"] = None
        self.save()
    
    def mark_in_progress(self, url: str):
        """Mark URL as currently downloading."""
        self.state["in_progress"] = url
        self.save()
    
    def get_retry_count(self, url: str) -> int:
        """Get number of retries for a URL."""
        return self.state["failed"].get(url, {}).get("attempts", 0)
    
    def get_summary(self) -> Dict:
        """Get summary of state."""
        return {
            "completed": len(self.state["completed"]),
            "failed": len(self.state["failed"]),
            "in_progress": self.state["in_progress"] is not None
        }


# ============================================================================
# METADATA EXTRACTION
# ============================================================================

def extract_sveltekit_data(html: str) -> Optional[Dict]:
    """Extract SvelteKit JSON data from page HTML."""
    # Pattern to find the embedded data
    patterns = [
        r'__sveltekit_\w+\.data\s*=\s*(\[.*?\]);',
        r'data-sveltekit-fetched[^>]*>([^<]+)</script>',
    ]
    
    for pattern in patterns:
        match = re.search(pattern, html, re.DOTALL)
        if match:
            try:
                # The data might be in a special format, try to parse
                data_str = match.group(1)
                return json.loads(data_str)
            except json.JSONDecodeError:
                continue
    
    return None


def extract_video_info_from_scripts(html: str) -> Optional[Dict]:
    """Extract video info from script tags - alternative method."""
    # Look for video configuration in various formats
    
    # Method 1: Find video ID in data attributes or inline scripts
    video_id_match = re.search(r'["\']?video["\']?:\s*{[^}]*["\']?id["\']?:\s*["\']([a-f0-9-]+)["\']', html, re.IGNORECASE)
    
    # Method 2: Look for API endpoints
    api_match = re.search(r'/api/video/([a-f0-9-]+)/playlist\.m3u8', html)
    
    # Method 3: Look for source paths
    source_match = re.search(r'(others/[^"\']+\.mp4)', html)
    
    video_id = None
    if api_match:
        video_id = api_match.group(1)
    elif video_id_match:
        video_id = video_id_match.group(1)
    
    if video_id:
        return {"video_id": video_id, "source_path": source_match.group(1) if source_match else None}
    
    return None


def parse_page_content(html: str, url: str) -> Dict:
    """Parse Artycok.tv page and extract video metadata."""
    result = {
        "url": url,
        "title": None,
        "artist": None,
        "director": None,
        "year": None,
        "video_id": None,
        "qualities": [],
        "manifest_url": None,
        "source_paths": [],
        # Additional metadata for NFO
        "tags": [],
        "description": None,
        "category": None,
        "language": None,
        "published_date": None,
        "runtime_minutes": None,
    }
    
    # Try to extract from page title
    title_match = re.search(r'<title>([^<]+)</title>', html)
    if title_match:
        full_title = title_match.group(1).strip()
        # Remove site suffix (handle various encodings of Artyčok)
        # The č might be encoded differently in HTML
        full_title = re.sub(r'\s*\|\s*Arty[čc\u010d]ok\s*TV\s*$', '', full_title, flags=re.IGNORECASE).strip()
        # Also handle cases where | might be HTML encoded
        full_title = re.sub(r'\s*[\|&#124;]+\s*Arty.*?TV\s*$', '', full_title, flags=re.IGNORECASE).strip()
        result["title"] = full_title if full_title else None
    
    # Fallback: Extract title from URL slug
    if not result["title"]:
        url_path = urlparse(url).path
        slug = url_path.rstrip('/').split('/')[-1]
        # Convert slug to title case, replace hyphens with spaces
        result["title"] = slug.replace('-', ' ').title()
    
    # Try to find artist/director name - look for "umělci" (artists) section
    artist_patterns = [
        # Link to artist page
        r'href="/cs/artist/[^"]*">([^<]+)<',
        # Artist class
        r'class="[^"]*artist[^"]*"[^>]*>([^<]+)<',
        # JSON data with artists
        r'"artists":\s*\[\s*{\s*"[^"]*name[^"]*":\s*"([^"]+)"',
        # Author link pattern
        r'href="/[^"]*artist[^"]*"[^>]*>([^<]+)</a>',
    ]
    for pattern in artist_patterns:
        match = re.search(pattern, html, re.IGNORECASE)
        if match:
            artist_name = match.group(1).strip()
            result["artist"] = artist_name
            # For short films, artist is typically the director
            result["director"] = artist_name
            break
    
    # Try to extract year from text - look for "z roku YYYY" pattern
    year_patterns = [
        r'z roku\s+(\d{4})',  # "z roku 2007"
        r'rok[u]?\s+(\d{4})',  # "roku 2007" or "rok 2007"
        r'\((\d{4})\)',  # "(2007)"
        r'"year":\s*(\d{4})',  # JSON year
        r'(\d{4})\s*[-–]\s*\d{4}',  # "2007-2008" range, take first
    ]
    for pattern in year_patterns:
        match = re.search(pattern, html)
        if match:
            year = int(match.group(1))
            # Sanity check: year should be reasonable (1900-2030)
            if 1900 <= year <= 2030:
                result["year"] = year
                break
    
    # Fallback: Try to extract year from publication date in page
    if not result["year"]:
        # Look for date patterns like "5. 8. 2009" or "2009-08-05"
        date_patterns = [
            r'publikováno[:\s]*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})',
            r'(\d{4})-(\d{2})-(\d{2})',
        ]
        for pattern in date_patterns:
            match = re.search(pattern, html, re.IGNORECASE)
            if match:
                groups = match.groups()
                year = int(groups[-1]) if len(groups[-1]) == 4 else int(groups[0])
                if 1900 <= year <= 2030:
                    result["year"] = year
                    break
    
    # Extract video ID and info
    video_info = extract_video_info_from_scripts(html)
    if video_info:
        result["video_id"] = video_info.get("video_id")
        if video_info.get("source_path"):
            result["source_paths"].append(video_info["source_path"])
    
    # Look for video ID in data blobs
    if not result["video_id"]:
        # Try to find UUID-style video IDs
        uuid_pattern = r'["\']([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})["\']'
        uuids = re.findall(uuid_pattern, html)
        # Try each as potential video ID
        for uuid in set(uuids):
            if 'video' in html[max(0, html.find(uuid)-200):html.find(uuid)+50].lower():
                result["video_id"] = uuid
                break
    
    # Extract quality options from source paths
    quality_pattern = r'(\d{3,4}p?)\.mp4'
    for match in re.finditer(quality_pattern, html):
        q = match.group(1)
        if not q.endswith('p'):
            q += 'p'
        if q not in result["qualities"]:
            result["qualities"].append(q)
    
    # Sort qualities by preference
    result["qualities"] = sorted(
        result["qualities"],
        key=lambda x: QUALITY_ORDER.index(x) if x in QUALITY_ORDER else 999
    )
    
    # Construct manifest URL if we have video ID
    if result["video_id"]:
        result["manifest_url"] = f"https://artycok.tv/api/video/{result['video_id']}/playlist.m3u8"
    
    # =========================================================================
    # ADDITIONAL METADATA FOR NFO
    # =========================================================================
    
    # Extract tags (look for tag links)
    tag_patterns = [
        r'href="/cs/tag/[^"]*">([^<]+)</a>',  # Tag links
        r'class="[^"]*tag[^"]*"[^>]*>([^<]+)<',  # Tag elements
        r'"tags":\s*\[([^\]]+)\]',  # JSON tags array
    ]
    for pattern in tag_patterns:
        matches = re.findall(pattern, html, re.IGNORECASE)
        if matches:
            for m in matches:
                # Handle JSON array format
                if ',' in m and '"' in m:
                    json_tags = re.findall(r'"([^"]+)"', m)
                    result["tags"].extend(json_tags)
                else:
                    tag = m.strip()
                    if tag and tag not in result["tags"] and len(tag) < 50:
                        result["tags"].append(tag)
    
    # Remove duplicates and clean
    result["tags"] = list(dict.fromkeys([t.strip() for t in result["tags"] if t.strip()]))
    
    # Extract description/plot (look for meta description or content)
    desc_patterns = [
        r'<meta[^>]*name="description"[^>]*content="([^"]+)"',
        r'<meta[^>]*property="og:description"[^>]*content="([^"]+)"',
        r'class="[^"]*description[^"]*"[^>]*>([^<]+(?:<[^>]+>[^<]*)*)</[^>]+>',
    ]
    for pattern in desc_patterns:
        match = re.search(pattern, html, re.IGNORECASE | re.DOTALL)
        if match:
            desc = match.group(1).strip()
            # Clean HTML tags
            desc = re.sub(r'<[^>]+>', ' ', desc)
            desc = re.sub(r'\s+', ' ', desc).strip()
            if desc and len(desc) > 20:
                result["description"] = desc
                break
    
    # Extract category
    category_patterns = [
        r'class="[^"]*category[^"]*"[^>]*>([^<]+)<',
        r'href="/cs/category/[^"]*">([^<]+)</a>',
        r'"category":\s*"([^"]+)"',
    ]
    for pattern in category_patterns:
        match = re.search(pattern, html, re.IGNORECASE)
        if match:
            result["category"] = match.group(1).strip()
            break
    
    # If no category found, try to detect from content type
    if not result["category"]:
        if 'audio-vizuální' in html.lower() or 'videoart' in html.lower():
            result["category"] = "Audio-vizuální umění"
        elif 'dokumentární' in html.lower():
            result["category"] = "Dokumentární"
        elif 'animace' in html.lower():
            result["category"] = "Animace"
    
    # Extract language
    lang_patterns = [
        r'jazyk[:\s]*([^<\n]+)',
        r'language[:\s]*([^<\n]+)',
        r'"language":\s*"([^"]+)"',
    ]
    for pattern in lang_patterns:
        match = re.search(pattern, html, re.IGNORECASE)
        if match:
            lang = match.group(1).strip()
            if lang and len(lang) < 50:
                result["language"] = lang
                break
    
    # Extract publication date
    pub_patterns = [
        r'publikováno[:\s]*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})',
        r'"publishedAt":\s*"([^"]+)"',
        r'"datePublished":\s*"([^"]+)"',
    ]
    for pattern in pub_patterns:
        match = re.search(pattern, html, re.IGNORECASE)
        if match:
            groups = match.groups()
            if len(groups) == 3:
                # Format: DD.MM.YYYY
                result["published_date"] = f"{groups[2]}-{groups[1].zfill(2)}-{groups[0].zfill(2)}"
            else:
                # ISO format or similar
                result["published_date"] = groups[0][:10]  # Take first 10 chars (YYYY-MM-DD)
            break
    
    return result


def generate_nfo_content(metadata: Dict, duration_seconds: Optional[float] = None) -> str:
    """Generate Kodi/Jellyfin compatible NFO XML content."""
    from xml.sax.saxutils import escape
    
    title = escape(metadata.get("title") or "Unknown")
    year = metadata.get("year") or ""
    director = escape(metadata.get("director") or metadata.get("artist") or "")
    description = escape(metadata.get("description") or "")
    
    # Calculate runtime in minutes
    if duration_seconds:
        runtime = int(duration_seconds / 60)
    elif metadata.get("runtime_minutes"):
        runtime = metadata["runtime_minutes"]
    else:
        runtime = ""
    
    lines = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<movie>',
        f'  <title>{title}</title>',
        f'  <originaltitle>{title}</originaltitle>',
    ]
    
    if year:
        lines.append(f'  <year>{year}</year>')
    
    if description:
        lines.append(f'  <plot>{description}</plot>')
        lines.append(f'  <outline>{description[:200]}{"..." if len(description) > 200 else ""}</outline>')
    
    if runtime:
        lines.append(f'  <runtime>{runtime}</runtime>')
    
    if director:
        lines.append(f'  <director>{director}</director>')
    
    # Add artist as actor/credit
    artist = metadata.get("artist")
    if artist:
        lines.append('  <credits>' + escape(artist) + '</credits>')
        lines.append('  <actor>')
        lines.append(f'    <name>{escape(artist)}</name>')
        lines.append('    <role>Artist/Creator</role>')
        lines.append('  </actor>')
    
    # Add category as genre
    category = metadata.get("category")
    if category:
        lines.append(f'  <genre>{escape(category)}</genre>')
    
    # Add all tags
    for tag in metadata.get("tags", []):
        lines.append(f'  <tag>{escape(tag)}</tag>')
    
    # Add language
    language = metadata.get("language")
    if language:
        lines.append(f'  <language>{escape(language)}</language>')
    
    # Add source URL
    source_url = metadata.get("url")
    if source_url:
        lines.append(f'  <website>{escape(source_url)}</website>')
    
    # Add publication date
    pub_date = metadata.get("published_date")
    if pub_date:
        lines.append(f'  <premiered>{pub_date}</premiered>')
        lines.append(f'  <releasedate>{pub_date}</releasedate>')
    
    # Add studio
    lines.append('  <studio>Artyčok TV</studio>')
    
    # Add country (Czech content)
    lines.append('  <country>Czech Republic</country>')
    
    lines.append('</movie>')
    
    return '\n'.join(lines)


def save_nfo_file(video_path: Path, metadata: Dict, duration_seconds: Optional[float] = None) -> Path:
    """Save NFO file next to the video file."""
    nfo_content = generate_nfo_content(metadata, duration_seconds)
    nfo_path = video_path.with_suffix('.nfo')
    
    with open(nfo_path, 'w', encoding='utf-8') as f:
        f.write(nfo_content)
    
    return nfo_path


def fetch_page(url: str) -> str:
    """Fetch page HTML content with proper encoding."""
    response = requests.get(url, headers=HEADERS, timeout=30)
    response.raise_for_status()
    # Force UTF-8 encoding for proper Czech diacritics handling
    response.encoding = 'utf-8'
    return response.text


def get_video_metadata(url: str) -> Dict:
    """Fetch page and extract video metadata."""
    html = fetch_page(url)
    return parse_page_content(html, url)


# ============================================================================
# DOWNLOAD LOGIC
# ============================================================================

def sanitize_filename(name: str) -> str:
    """Create safe filename from string."""
    # Remove/replace problematic characters
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    name = re.sub(r'[\x00-\x1f\x7f]', '', name)
    name = re.sub(r'\s+', ' ', name)
    return name.strip()[:200]


def build_output_filename(metadata: Dict, output_dir: Path) -> Path:
    """Build output filename from metadata in Jellyfin format: Title (Year)/Title (Year).mp4"""
    title = sanitize_filename(metadata.get("title") or "Unknown")
    year = metadata.get("year")
    director = metadata.get("director") or metadata.get("artist")
    
    # Build Jellyfin-compatible name: Title (Year)
    if year:
        folder_name = f"{title} ({year})"
    else:
        folder_name = title
    
    # Create folder structure
    folder_path = output_dir / folder_name
    folder_path.mkdir(parents=True, exist_ok=True)
    
    # Filename matches folder name
    return folder_path / f"{folder_name}.mp4"


def get_video_duration(file_path: Path) -> Optional[float]:
    """Get video duration in seconds using ffprobe."""
    try:
        cmd = [
            'ffprobe',
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            str(file_path)
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            data = json.loads(result.stdout)
            return float(data.get('format', {}).get('duration', 0))
    except Exception:
        pass
    return None


def classify_and_move(file_path: Path, base_output_dir: Path, duration_seconds: Optional[float]) -> Path:
    """Move file to shorts/ or features/ subfolder based on duration."""
    if duration_seconds is None:
        # Default to shorts if we can't determine duration
        category = "shorts"
        print_warning("Could not determine duration, defaulting to shorts/")
    else:
        duration_minutes = duration_seconds / 60
        if duration_minutes <= SHORT_FILM_MAX_DURATION:
            category = "shorts"
            print_info(f"Duration: {duration_minutes:.1f} min → classified as SHORT")
        else:
            category = "features"
            print_info(f"Duration: {duration_minutes:.1f} min → classified as FEATURE")
    
    # Get the movie folder (parent of the file)
    movie_folder = file_path.parent
    movie_folder_name = movie_folder.name
    
    # Create target directory
    target_dir = base_output_dir / category / movie_folder_name
    target_dir.mkdir(parents=True, exist_ok=True)
    
    # Move all files from movie folder to target
    target_file = target_dir / file_path.name
    
    if movie_folder != target_dir:
        import shutil
        # Move the entire folder contents
        for item in movie_folder.iterdir():
            shutil.move(str(item), str(target_dir / item.name))
        # Remove empty source folder
        try:
            movie_folder.rmdir()
        except OSError:
            pass
    
    return target_file


def download_with_ytdlp(manifest_url: str, output_path: Path, quality: str = "1080p", verbose: bool = False) -> bool:
    """Download video using yt-dlp."""
    # Convert quality to height number
    height = re.sub(r'[^0-9]', '', quality) or "1080"
    
    # Ensure parent directory exists
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    cmd = [
        'yt-dlp',
        '--no-check-certificate',
        '-f', f'bestvideo[height<={height}]+bestaudio/best[height<={height}]/best',
        '--merge-output-format', 'mp4',
        '-o', str(output_path),
        '--no-warnings',
        '--progress',
    ]
    
    if not verbose:
        cmd.append('--quiet')
        cmd.append('--progress')
    
    cmd.append(manifest_url)
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=not verbose,
            text=True,
            timeout=3600  # 1 hour timeout
        )
        return result.returncode == 0 and output_path.exists()
    except subprocess.TimeoutExpired:
        print_error("Download timed out")
        return False
    except Exception as e:
        print_error(f"Download error: {e}")
        return False


def download_video(metadata: Dict, output_dir: Path, quality: str, force: bool = False, verbose: bool = False) -> tuple[bool, Path]:
    """Download a single video with Jellyfin-compatible folder structure."""
    # Build initial output path (will be moved to shorts/features after)
    temp_output = build_output_filename(metadata, output_dir / "_processing")
    final_folder_name = temp_output.parent.name
    
    # Check if already exists in shorts or features
    for category in ["shorts", "features"]:
        existing_path = output_dir / category / final_folder_name / temp_output.name
        if existing_path.exists() and not force:
            size_mb = existing_path.stat().st_size / (1024 * 1024)
            print_info(f"Already exists in {category}/: {existing_path.name} ({size_mb:.1f} MB)")
            return True, existing_path
    
    if not metadata.get("manifest_url"):
        print_error("No manifest URL found")
        return False, temp_output
    
    print_info(f"Downloading: {temp_output.name}")
    if metadata.get("director"):
        print_info(f"Director: {metadata['director']}")
    if metadata.get("year"):
        print_info(f"Year: {metadata['year']}")
    print_info(f"Quality: {quality}")
    
    success = download_with_ytdlp(metadata["manifest_url"], temp_output, quality, verbose)
    
    if success and temp_output.exists():
        size_mb = temp_output.stat().st_size / (1024 * 1024)
        print_success(f"Downloaded: {size_mb:.1f} MB")
        
        # Get duration and classify
        duration = get_video_duration(temp_output)
        
        # Save NFO file before moving (so it gets moved with the video)
        nfo_path = save_nfo_file(temp_output, metadata, duration)
        print_success(f"Created NFO: {nfo_path.name}")
        
        # Now move to shorts/features
        final_path = classify_and_move(temp_output, output_dir, duration)
        
        print_success(f"Saved to: {final_path.relative_to(output_dir)}")
        return True, final_path
    else:
        print_error("Download failed")
        # Clean up empty folders
        try:
            temp_output.parent.rmdir()
        except OSError:
            pass
        return False, temp_output


# ============================================================================
# BATCH PROCESSING
# ============================================================================

def load_urls_from_json(json_path: str) -> List[str]:
    """Load URLs from JSON file."""
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    # Support multiple formats
    if isinstance(data, list):
        return [item if isinstance(item, str) else item.get('url', '') for item in data]
    elif isinstance(data, dict):
        if 'urls' in data:
            return data['urls']
        elif 'videos' in data:
            return [v.get('url', '') for v in data['videos']]
    
    return []


def process_batch(urls: List[str], output_dir: Path, quality: str, force: bool, verbose: bool, skip_existing: bool = True) -> Dict:
    """Process multiple URLs with state management."""
    state = StateManager(output_dir)
    
    results = {
        "success": 0,
        "failed": 0,
        "skipped": 0,
        "total": len(urls)
    }
    
    for i, url in enumerate(urls, 1):
        url = url.strip()
        if not url or not url.startswith('http'):
            continue
        
        # Check if already completed
        if skip_existing and state.is_completed(url):
            print_progress(i, len(urls), f"[SKIP] Already completed")
            results["skipped"] += 1
            continue
        
        # Check retry count
        retry_count = state.get_retry_count(url)
        if retry_count >= MAX_RETRIES:
            print_progress(i, len(urls), f"[SKIP] Max retries exceeded")
            results["skipped"] += 1
            continue
        
        try:
            print_progress(i, len(urls), url)
            state.mark_in_progress(url)
            
            metadata = get_video_metadata(url)
            title = metadata.get('title', 'Unknown')
            artist = metadata.get('artist', '')
            
            print_info(f"Title: {title}")
            if artist:
                print_info(f"Artist: {artist}")
            
            if not metadata.get("video_id"):
                raise ValueError("Could not extract video ID from page")
            
            success, output_path = download_video(metadata, output_dir, quality, force, verbose)
            
            if success:
                state.mark_completed(url)
                results["success"] += 1
            else:
                state.mark_failed(url, "Download failed")
                results["failed"] += 1
                
        except KeyboardInterrupt:
            print_warning("\nInterrupted by user. Progress saved.")
            state.save()
            sys.exit(1)
        except Exception as e:
            print_error(f"Error: {e}")
            state.mark_failed(url, str(e))
            results["failed"] += 1
            if retry_count < MAX_RETRIES - 1:
                print_info(f"Will retry on next run ({retry_count + 1}/{MAX_RETRIES})")
    
    return results


# ============================================================================
# CLI ENTRY POINT
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description='Download videos from artycok.tv',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s https://artycok.tv/cs/post/route
  %(prog)s --json urls.json --output-dir ./downloads
  %(prog)s https://artycok.tv/cs/post/route --quality 720p --dry-run
        """
    )
    
    # Input options
    parser.add_argument('url', nargs='?', help='URL to download')
    parser.add_argument('--json', '-j', metavar='FILE', help='JSON file with list of URLs')
    
    # Output options
    parser.add_argument('--output-dir', '-o', default=DEFAULT_OUTPUT_DIR,
                        help=f'Output directory (default: {DEFAULT_OUTPUT_DIR})')
    parser.add_argument('--quality', '-q', default=DEFAULT_QUALITY,
                        choices=['1080p', '720p', '576p', '480p', '360p'],
                        help=f'Preferred quality (default: {DEFAULT_QUALITY})')
    
    # Behavior options
    parser.add_argument('--dry-run', action='store_true',
                        help='Parse metadata only, do not download')
    parser.add_argument('--force', '-f', action='store_true',
                        help='Re-download even if file exists')
    parser.add_argument('--no-skip', action='store_true',
                        help='Do not skip previously completed downloads')
    parser.add_argument('--verbose', '-v', action='store_true',
                        help='Show detailed output')
    
    # Info options
    parser.add_argument('--status', '-s', action='store_true',
                        help='Show download state and exit')
    parser.add_argument('--clear-state', action='store_true',
                        help='Clear download state and start fresh')
    
    args = parser.parse_args()
    
    # Validate input
    if not args.url and not args.json and not args.status:
        parser.error("Either URL or --json is required")
    
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Handle state commands
    if args.status:
        state = StateManager(output_dir)
        summary = state.get_summary()
        print_header("Artycok Download Status")
        print(f"  Completed: {summary['completed']}")
        print(f"  Failed: {summary['failed']}")
        print(f"  In Progress: {'Yes' if summary['in_progress'] else 'No'}")
        return
    
    if args.clear_state:
        state_file = output_dir / STATE_FILE_NAME
        if state_file.exists():
            state_file.unlink()
            print_success("State cleared")
        return
    
    print_header("Artycok.tv Downloader")
    
    # Collect URLs
    urls = []
    if args.json:
        if not os.path.exists(args.json):
            print_error(f"JSON file not found: {args.json}")
            sys.exit(1)
        urls = load_urls_from_json(args.json)
        print_info(f"Loaded {len(urls)} URLs from {args.json}")
    elif args.url:
        urls = [args.url]
    
    if not urls:
        print_error("No valid URLs found")
        sys.exit(1)
    
    print_info(f"Output directory: {output_dir}")
    print_info(f"Quality preference: {args.quality}")
    
    # Dry run mode
    if args.dry_run:
        print_header("Dry Run - Metadata Only")
        for url in urls:
            print(f"\n{'─' * 60}")
            print(f"URL: {url}")
            try:
                metadata = get_video_metadata(url)
                print(f"  Title: {metadata.get('title', 'N/A')}")
                print(f"  Director: {metadata.get('director') or metadata.get('artist') or 'N/A'}")
                print(f"  Year: {metadata.get('year', 'N/A')}")
                print(f"  Category: {metadata.get('category', 'N/A')}")
                tags = metadata.get('tags', [])
                print(f"  Tags: {', '.join(tags) if tags else 'N/A'}")
                desc = metadata.get('description', '')
                if desc:
                    print(f"  Description: {desc[:100]}{'...' if len(desc) > 100 else ''}")
                print(f"  Language: {metadata.get('language', 'N/A')}")
                print(f"  Published: {metadata.get('published_date', 'N/A')}")
                print(f"  Video ID: {metadata.get('video_id', 'N/A')}")
                print(f"  Qualities: {', '.join(metadata.get('qualities', [])) or 'N/A'}")
                output_path = build_output_filename(metadata, output_dir / "_preview")
                print(f"  Output: shorts|features/{output_path.parent.name}/{output_path.name}")
                print(f"  NFO: {output_path.parent.name}/{output_path.stem}.nfo")
                # Clean up preview folder
                try:
                    output_path.parent.rmdir()
                except OSError:
                    pass
            except Exception as e:
                print_error(f"Error: {e}")
        return
    
    # Process downloads
    if len(urls) == 1:
        # Single URL mode
        try:
            metadata = get_video_metadata(urls[0])
            print_info(f"Title: {metadata.get('title', 'Unknown')}")
            if metadata.get('artist'):
                print_info(f"Artist: {metadata['artist']}")
            
            success, output_path = download_video(metadata, output_dir, args.quality, args.force, args.verbose)
            sys.exit(0 if success else 1)
        except Exception as e:
            print_error(f"Error: {e}")
            sys.exit(1)
    else:
        # Batch mode
        results = process_batch(
            urls, output_dir, args.quality, args.force, args.verbose,
            skip_existing=not args.no_skip
        )
        
        print_header("Download Complete")
        print(f"  {Colors.GREEN}Success:{Colors.RESET} {results['success']}")
        print(f"  {Colors.YELLOW}Skipped:{Colors.RESET} {results['skipped']}")
        print(f"  {Colors.RED}Failed:{Colors.RESET} {results['failed']}")
        print(f"  Total: {results['total']}")
        
        if results['failed'] > 0:
            print_info("Run again to retry failed downloads")


if __name__ == '__main__':
    main()
