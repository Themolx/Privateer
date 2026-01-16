#!/usr/bin/env python3
"""
DAFilms.cz Downloader - Download documentary films from dafilms.cz

Downloads videos from dafilms.cz using cookie-based authentication.
Uses Playwright for browser automation to extract signed CloudFront URLs.
Supports batch processing, quality selection, and Jellyfin-compatible naming.

Usage:
    python dafilms_dl.py URL                              # Download single video
    python dafilms_dl.py --json wanted_dafilms.json       # Batch from JSON file
    python dafilms_dl.py URL --quality sd                 # Select SD quality
    python dafilms_dl.py URL --dry-run                    # Parse only, no download
    
Examples:
    python dafilms_dl.py https://dafilms.cz/film/12836-modern-times
    python dafilms_dl.py --json dafilms_urls.json --output-dir ./downloads
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
from urllib.parse import urlparse, urljoin
import asyncio

import requests

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("ERROR: playwright not installed")
    print("Run: pip install playwright && python -m playwright install chromium")
    sys.exit(1)

# ============================================================================
# CONFIGURATION
# ============================================================================

SCRIPT_DIR = Path(__file__).parent.resolve()
DEFAULT_OUTPUT_DIR = "./downloads"
DEFAULT_COOKIES_FILE = str(SCRIPT_DIR / "cookies.txt")

STATE_FILE_NAME = ".dafilms_state.json"
MAX_RETRIES = 3
RETRY_DELAY = 5  # seconds

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'cs,en-US;q=0.7,en;q=0.3',
    'Referer': 'https://dafilms.cz/',
}

# Duration threshold for short vs feature classification (in minutes)
SHORT_FILM_MAX_DURATION = 40

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
# COOKIE HANDLING
# ============================================================================

def parse_cookies_file(cookies_path: str) -> Dict[str, Dict[str, str]]:
    """
    Parse cookies from browser export file.
    Supports multiple formats: Netscape, JSON, EditThisCookie tab-format.
    Returns dict grouped by domain.
    """
    cookies_by_domain = {}
    
    with open(cookies_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Try JSON format first
    try:
        data = json.loads(content)
        if isinstance(data, list):
            for c in data:
                domain = c.get('domain', '')
                if domain not in cookies_by_domain:
                    cookies_by_domain[domain] = {}
                cookies_by_domain[domain][c['name']] = c['value']
            return cookies_by_domain
    except json.JSONDecodeError:
        pass
    
    # Try tab-separated format (EditThisCookie export)
    for line in content.strip().split('\n'):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        
        parts = line.split('\t')
        if len(parts) >= 3:
            # Format: name, value, domain, path, expiry, ...
            # Or: name\tvalue (simple format)
            if len(parts) >= 5:
                # Standard Netscape format: domain, flag, path, secure, expiry, name, value
                try:
                    domain = parts[2] if '@' not in parts[0] else parts[2]
                    name = parts[0]
                    value = parts[1]
                    
                    # Check if it looks like dafilms domain
                    if 'dafilms' in domain or domain.startswith('.dafilms'):
                        if domain not in cookies_by_domain:
                            cookies_by_domain[domain] = {}
                        cookies_by_domain[domain][name] = value
                except (IndexError, ValueError):
                    continue
    
    # Specific parsing for the format we see in cookies.txt
    # Format: name<TAB>value<TAB>domain<TAB>path<TAB>expiry<TAB>...
    for line in content.strip().split('\n'):
        parts = line.split('\t')
        if len(parts) >= 3:
            name = parts[0].strip()
            value = parts[1].strip()
            domain = parts[2].strip()
            
            # Only keep dafilms.cz cookies
            if 'dafilms' in domain:
                if domain not in cookies_by_domain:
                    cookies_by_domain[domain] = {}
                cookies_by_domain[domain][name] = value
    
    return cookies_by_domain


def get_dafilms_cookies(cookies_path: str) -> Dict[str, str]:
    """Get DAFilms.cz specific cookies for requests."""
    all_cookies = parse_cookies_file(cookies_path)
    
    result = {}
    for domain, cookies in all_cookies.items():
        if 'dafilms' in domain:
            result.update(cookies)
    
    return result


def cookies_to_playwright_format(cookies_path: str) -> List[Dict]:
    """Convert cookies to Playwright format for browser context."""
    all_cookies = parse_cookies_file(cookies_path)
    playwright_cookies = []
    
    for domain, cookies in all_cookies.items():
        for name, value in cookies.items():
            cookie = {
                'name': name,
                'value': value,
                'domain': domain if domain.startswith('.') else domain,
                'path': '/',
            }
            playwright_cookies.append(cookie)
    
    return playwright_cookies


# ============================================================================
# METADATA EXTRACTION
# ============================================================================

def parse_page_metadata(html: str, url: str) -> Dict:
    """Parse DAFilms page and extract video metadata."""
    result = {
        "url": url,
        "title": None,
        "original_title": None,
        "director": None,
        "year": None,
        "duration_minutes": None,
        "country": None,
        "language": None,
        "description": None,
        "tags": [],
        "csfd_url": None,
        "kinobox_url": None,
    }
    
    # Extract title from <title> tag
    title_match = re.search(r'<title>([^<]+)</title>', html)
    if title_match:
        full_title = title_match.group(1).strip()
        # Remove site suffix
        full_title = re.sub(r'\s*[-–|]\s*dafilms\.cz.*$', '', full_title, flags=re.IGNORECASE).strip()
        result["title"] = full_title
    
    # Extract original title
    orig_match = re.search(r'Originální\s+název\s*</?\w*>\s*([^<]+)', html, re.IGNORECASE)
    if orig_match:
        result["original_title"] = orig_match.group(1).strip()
    
    # Extract director - look for "Režie" label followed by value
    director_patterns = [
        # Structure: <div class="label">Režie</div><div class="value">...<a href="/director/...">Name</a>
        r'class="label"[^>]*>\s*Režie\s*</div>\s*<div[^>]*class="value"[^>]*>.*?<a[^>]*>([^<]+)</a>',
        r'>Režie</div>\s*<div[^>]*>.*?<a[^>]*href="/director/[^"]*"[^>]*>([^<]+)</a>',
        r'href="/director/[^"]*"[^>]*>([^<]+)</a>',
    ]
    for pattern in director_patterns:
        match = re.search(pattern, html, re.IGNORECASE | re.DOTALL)
        if match:
            result["director"] = match.group(1).strip()
            break
    
    # Extract year - look for "Rok" label followed by value
    year_patterns = [
        # Structure: <div class="label">Rok</div><div class="value">2020</div>
        r'class="label"[^>]*>\s*Rok\s*</div>\s*<div[^>]*class="value"[^>]*>\s*(\d{4})',
        r'>Rok</div>\s*<div[^>]*>\s*(\d{4})',
        r'Rok[^<]*</div>\s*<div[^>]*>\s*(\d{4})',
        # Fallback: summary line like "Director 2020 / Country / 18min"
        r'\b(20[012]\d|19\d{2})\s*/\s*[^/]+/\s*\d+\s*min',
    ]
    for pattern in year_patterns:
        match = re.search(pattern, html, re.IGNORECASE)
        if match:
            year = int(match.group(1))
            if 1900 <= year <= 2030:
                result["year"] = year
                break
    
    # Extract duration - look for "Délka" label followed by value
    duration_patterns = [
        # Structure: <div class="label">Délka</div><div class="value">18 min</div>
        r'class="label"[^>]*>\s*Délka\s*</div>\s*<div[^>]*class="value"[^>]*>\s*(\d+)\s*min',
        r'>Délka</div>\s*<div[^>]*>\s*(\d+)\s*min',
        # Fallback: summary line like "18 min" or "18min"
        r'(\d{2,3})\s*min(?:\s*[<\.]|\s*$)',
    ]
    for pattern in duration_patterns:
        match = re.search(pattern, html, re.IGNORECASE | re.DOTALL)
        if match:
            result["duration_minutes"] = int(match.group(1))
            break
    
    # Extract country
    country_match = re.search(r'Země\s*</?\w*[^>]*>\s*([^<]+)', html, re.IGNORECASE)
    if country_match:
        result["country"] = country_match.group(1).strip()
    
    # Extract description from og:description
    desc_match = re.search(r'<meta[^>]*property="og:description"[^>]*content="([^"]+)"', html)
    if desc_match:
        result["description"] = desc_match.group(1).strip()
    
    # Extract CSFD link
    csfd_match = re.search(r'href="(https://www\.csfd\.cz/film/[^"]+)"', html)
    if csfd_match:
        result["csfd_url"] = csfd_match.group(1)
    
    # Extract Kinobox link
    kinobox_match = re.search(r'href="(https://www\.kinobox\.cz/film/[^"]+)"', html)
    if kinobox_match:
        result["kinobox_url"] = kinobox_match.group(1)
    
    # Extract language
    lang_match = re.search(r'href="/film\?f=a-\d+"[^>]*>([^<]+)</a>', html)
    if lang_match:
        result["language"] = lang_match.group(1).strip()
    
    return result


def generate_nfo_content(metadata: Dict, duration_seconds: Optional[float] = None) -> str:
    """Generate Kodi/Jellyfin compatible NFO XML content."""
    from xml.sax.saxutils import escape
    
    title = escape(metadata.get("title") or "Unknown")
    original_title = escape(metadata.get("original_title") or title)
    year = metadata.get("year") or ""
    director = escape(metadata.get("director") or "")
    description = escape(metadata.get("description") or "")
    country = escape(metadata.get("country") or "")
    
    # Calculate runtime in minutes
    if duration_seconds:
        runtime = int(duration_seconds / 60)
    elif metadata.get("duration_minutes"):
        runtime = metadata["duration_minutes"]
    else:
        runtime = ""
    
    lines = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<movie>',
        f'  <title>{title}</title>',
        f'  <originaltitle>{original_title}</originaltitle>',
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
    
    if country:
        lines.append(f'  <country>{country}</country>')
    
    # Add genre for documentaries
    lines.append('  <genre>Documentary</genre>')
    
    # Add source URL
    source_url = metadata.get("url")
    if source_url:
        lines.append(f'  <website>{escape(source_url)}</website>')
    
    # Add CSFD link as uniqueid
    if metadata.get("csfd_url"):
        csfd_id = re.search(r'film/(\d+)', metadata["csfd_url"])
        if csfd_id:
            lines.append(f'  <uniqueid type="csfd">{csfd_id.group(1)}</uniqueid>')
    
    # Add studio
    lines.append('  <studio>DAFilms</studio>')
    
    lines.append('</movie>')
    
    return '\n'.join(lines)


def save_nfo_file(video_path: Path, metadata: Dict, duration_seconds: Optional[float] = None) -> Path:
    """Save NFO file next to the video file."""
    nfo_content = generate_nfo_content(metadata, duration_seconds)
    nfo_path = video_path.with_suffix('.nfo')
    
    with open(nfo_path, 'w', encoding='utf-8') as f:
        f.write(nfo_content)
    
    return nfo_path


# ============================================================================
# VIDEO EXTRACTION (using Playwright)
# ============================================================================

async def extract_video_urls_playwright(url: str, cookies_path: str) -> Dict:
    """
    Use Playwright to load the page with cookies and extract video URLs.
    Returns dict with metadata and video sources.
    """
    result = {
        "metadata": {},
        "sources": [],
        "error": None,
        "logged_in": False,
    }
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        
        # Create context with cookies
        context = await browser.new_context(
            user_agent=HEADERS['User-Agent'],
        )
        
        # Load cookies if file exists
        if os.path.exists(cookies_path):
            cookies = cookies_to_playwright_format(cookies_path)
            if cookies:
                try:
                    # Filter to only dafilms.cz cookies for now
                    dafilms_cookies = [c for c in cookies if 'dafilms' in c.get('domain', '')]
                    if dafilms_cookies:
                        await context.add_cookies(dafilms_cookies)
                        print_info(f"Loaded {len(dafilms_cookies)} DAFilms cookies")
                except Exception as e:
                    print_warning(f"Could not load all cookies: {e}")
        
        page = await context.new_page()
        
        try:
            # Navigate to film page
            print_info(f"Loading page: {url}")
            await page.goto(url, wait_until='networkidle', timeout=30000)
            
            # Wait a bit for any dynamic content
            await page.wait_for_timeout(2000)
            
            # Check if logged in
            html = await page.content()
            if 'Profil' in html or 'Odhlásit' in html:
                result["logged_in"] = True
                print_success("Logged in successfully")
            else:
                print_warning("Not logged in - some content may be restricted")
            
            # Parse metadata from HTML
            result["metadata"] = parse_page_metadata(html, url)
            print_success(f"Title: {result['metadata'].get('title', 'Unknown')}")
            
            # Try to click play button to activate video player
            try:
                play_button = await page.query_selector('.vjs-big-play-button, [class*="play"], .film-detail__play')
                if play_button:
                    await play_button.click()
                    await page.wait_for_timeout(3000)
            except Exception:
                pass  # Play button might not be needed
            
            # Extract video sources using JavaScript
            sources_js = """
            (function() {
                let sources = [];
                
                // Check for video elements
                document.querySelectorAll('video').forEach(v => {
                    if (v.src) {
                        let quality = 'SD';
                        if (v.src.includes('720p')) quality = 'HD';
                        if (v.src.includes('1080p')) quality = 'FHD';
                        sources.push({url: v.src, type: 'video/mp4', quality: quality});
                    }
                    v.querySelectorAll('source').forEach(s => {
                        let quality = 'SD';
                        if (s.src.includes('720p')) quality = 'HD';
                        if (s.src.includes('1080p')) quality = 'FHD';
                        sources.push({url: s.src, type: s.type || 'video/mp4', quality: quality});
                    });
                });
                
                // Check Video.js player
                if (typeof videojs !== 'undefined') {
                    let players = videojs.getPlayers();
                    Object.values(players).forEach(p => {
                        if (p && p.src) {
                            let src = p.src();
                            if (src) {
                                let quality = 'SD';
                                if (src.includes('720p')) quality = 'HD';
                                if (src.includes('1080p')) quality = 'FHD';
                                sources.push({url: src, type: 'video/mp4', quality: quality});
                            }
                        }
                        // Also check source options
                        if (p && p.options_ && p.options_.sources) {
                            p.options_.sources.forEach(s => {
                                let quality = 'SD';
                                if (s.src && s.src.includes('720p')) quality = 'HD';
                                if (s.src && s.src.includes('1080p')) quality = 'FHD';
                                sources.push({url: s.src, type: s.type || 'video/mp4', quality: quality});
                            });
                        }
                    });
                }
                
                // Remove duplicates
                let seen = new Set();
                return sources.filter(s => {
                    if (!s.url || seen.has(s.url)) return false;
                    seen.add(s.url);
                    return true;
                });
            })();
            """
            
            sources = await page.evaluate(sources_js)
            result["sources"] = sources
            
            if sources:
                print_success(f"Found {len(sources)} video source(s)")
                for s in sources:
                    print_info(f"  {s['quality']}: {s['url'][:80]}...")
            else:
                print_warning("No video sources found - might need subscription or login")
                
                # Try to find any CloudFront URLs in the page
                cloudfront_match = re.findall(r'https://d\w+\.cloudfront\.net/[^"\']+\.mp4[^"\']*', html)
                if cloudfront_match:
                    for cf_url in cloudfront_match:
                        result["sources"].append({
                            "url": cf_url,
                            "type": "video/mp4",
                            "quality": "HD" if "720p" in cf_url else "SD"
                        })
                    print_success(f"Found {len(cloudfront_match)} CloudFront URL(s) in HTML")
        
        except Exception as e:
            result["error"] = str(e)
            print_error(f"Failed to extract video: {e}")
        
        finally:
            await browser.close()
    
    return result


# ============================================================================
# DOWNLOAD LOGIC
# ============================================================================

def sanitize_filename(name: str) -> str:
    """Create safe filename from string."""
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    name = re.sub(r'[\x00-\x1f\x7f]', '', name)
    name = re.sub(r'\s+', ' ', name)
    return name.strip()[:200]


def build_output_filename(metadata: Dict, output_dir: Path, classify: bool = True) -> Path:
    """
    Build output filename from metadata in Jellyfin format.
    Structure: {shorts|features}/Title (Year) - Director/Title (Year) - Director.mp4
    
    Films <= 40 min are classified as shorts, otherwise features.
    """
    title = sanitize_filename(metadata.get("title") or "Unknown")
    year = metadata.get("year")
    director = sanitize_filename(metadata.get("director") or "")
    duration = metadata.get("duration_minutes")
    
    # Build Jellyfin-compatible name: Title (Year) - Director
    parts = [title]
    if year:
        parts[0] = f"{title} ({year})"
    if director:
        folder_name = f"{parts[0]} - {director}"
    else:
        folder_name = parts[0]
    
    # Classify as short or feature based on duration
    if classify and duration:
        if duration <= SHORT_FILM_MAX_DURATION:
            category = "shorts"
        else:
            category = "features"
        base_dir = output_dir / category
    else:
        base_dir = output_dir
    
    # Create folder structure
    folder_path = base_dir / folder_name
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


def download_file(url: str, output_path: Path, headers: Dict = None) -> bool:
    """Download file with progress display."""
    try:
        response = requests.get(url, headers=headers or HEADERS, stream=True, timeout=30)
        response.raise_for_status()
        
        total_size = int(response.headers.get('content-length', 0))
        downloaded = 0
        
        output_path.parent.mkdir(parents=True, exist_ok=True)
        
        with open(output_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        pct = (downloaded / total_size) * 100
                        size_mb = downloaded / (1024 * 1024)
                        total_mb = total_size / (1024 * 1024)
                        print(f"\r  Downloading: {size_mb:.1f}/{total_mb:.1f} MB ({pct:.1f}%)", end='', flush=True)
        
        print()  # New line after progress
        return output_path.exists() and output_path.stat().st_size > 0
        
    except Exception as e:
        print_error(f"Download failed: {e}")
        return False


def select_best_source(sources: List[Dict], quality_pref: str = "hd") -> Optional[Dict]:
    """Select best video source based on quality preference."""
    if not sources:
        return None
    
    # Sort by quality preference
    quality_order = {'FHD': 0, 'HD': 1, 'SD': 2, 'default': 3}
    
    if quality_pref.lower() == 'sd':
        # Prefer SD
        quality_order = {'SD': 0, 'HD': 1, 'FHD': 2, 'default': 3}
    
    sorted_sources = sorted(sources, key=lambda x: quality_order.get(x.get('quality', 'default'), 99))
    return sorted_sources[0] if sorted_sources else None


async def download_video(url: str, output_dir: Path, cookies_path: str, 
                         quality: str = "hd", force: bool = False, 
                         dry_run: bool = False, verbose: bool = False) -> tuple[bool, Path]:
    """Download a single video with Jellyfin-compatible folder structure."""
    
    # Extract video info
    result = await extract_video_urls_playwright(url, cookies_path)
    
    if result["error"]:
        print_error(f"Extraction failed: {result['error']}")
        return False, Path()
    
    metadata = result["metadata"]
    sources = result["sources"]
    
    # Build output path
    output_path = build_output_filename(metadata, output_dir)
    
    # Check if already exists
    if output_path.exists() and not force:
        size_mb = output_path.stat().st_size / (1024 * 1024)
        print_info(f"Already exists: {output_path.name} ({size_mb:.1f} MB)")
        return True, output_path
    
    if dry_run:
        duration = metadata.get('duration_minutes')
        category = "SHORT" if duration and duration <= SHORT_FILM_MAX_DURATION else "FEATURE"
        print_header("DRY RUN - Would download:")
        print_info(f"Title: {metadata.get('title')}")
        print_info(f"Director: {metadata.get('director')}")
        print_info(f"Year: {metadata.get('year')}")
        print_info(f"Duration: {duration} min → {category}")
        print_info(f"Output: {output_path}")
        print_info(f"Sources found: {len(sources)}")
        return True, output_path
    
    if not sources:
        print_error("No video sources found")
        print_info("You may need to:")
        print_info("  1. Log in with Facebook in the browser")
        print_info("  2. Export fresh cookies to cookies.txt")
        print_info("  3. Make sure you have access to this content")
        return False, output_path
    
    # Select best source
    source = select_best_source(sources, quality)
    if not source:
        print_error("Could not select video source")
        return False, output_path
    
    print_info(f"Downloading {source['quality']}: {output_path.name}")
    
    # Download the video
    success = download_file(source['url'], output_path)
    
    if success and output_path.exists():
        size_mb = output_path.stat().st_size / (1024 * 1024)
        print_success(f"Downloaded: {size_mb:.1f} MB")
        
        # Get duration and save NFO
        duration = get_video_duration(output_path)
        nfo_path = save_nfo_file(output_path, metadata, duration)
        print_success(f"Created NFO: {nfo_path.name}")
        
        return True, output_path
    else:
        print_error("Download failed")
        return False, output_path


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
        elif 'films' in data:
            return [v.get('url', '') for v in data['films']]
    
    return []


async def process_batch(urls: List[str], output_dir: Path, cookies_path: str,
                        quality: str, force: bool, dry_run: bool, 
                        verbose: bool, skip_existing: bool = True) -> Dict:
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
            print_progress(i, len(urls), "[SKIP] Already completed")
            results["skipped"] += 1
            continue
        
        # Check retry count
        retry_count = state.get_retry_count(url)
        if retry_count >= MAX_RETRIES:
            print_progress(i, len(urls), "[SKIP] Max retries exceeded")
            results["skipped"] += 1
            continue
        
        try:
            state.mark_in_progress(url)
            print_progress(i, len(urls), url.split('/')[-1])
            
            success, _ = await download_video(url, output_dir, cookies_path, 
                                              quality, force, dry_run, verbose)
            
            if success:
                state.mark_completed(url)
                results["success"] += 1
            else:
                state.mark_failed(url, "Download failed")
                results["failed"] += 1
                
        except Exception as e:
            state.mark_failed(url, str(e))
            results["failed"] += 1
            print_error(f"Error: {e}")
        
        # Small delay between downloads
        if i < len(urls):
            await asyncio.sleep(2)
    
    return results


# ============================================================================
# MAIN
# ============================================================================

async def async_main():
    parser = argparse.ArgumentParser(
        description='Download videos from DAFilms.cz',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    %(prog)s https://dafilms.cz/film/12836-modern-times
    %(prog)s --json wanted_dafilms.json
    %(prog)s URL --quality sd --output-dir ./downloads
        """
    )
    
    parser.add_argument('url', nargs='?', help='DAFilms video URL')
    parser.add_argument('--json', '-j', help='JSON file with list of URLs')
    parser.add_argument('--output-dir', '-o', default=DEFAULT_OUTPUT_DIR,
                        help=f'Output directory (default: {DEFAULT_OUTPUT_DIR})')
    parser.add_argument('--cookies', '-c', default=DEFAULT_COOKIES_FILE,
                        help=f'Cookies file path (default: {DEFAULT_COOKIES_FILE})')
    parser.add_argument('--quality', '-q', choices=['hd', 'sd'], default='hd',
                        help='Video quality preference (default: hd)')
    parser.add_argument('--force', '-f', action='store_true',
                        help='Force re-download even if file exists')
    parser.add_argument('--dry-run', '-n', action='store_true',
                        help='Parse metadata only, do not download')
    parser.add_argument('--verbose', '-v', action='store_true',
                        help='Verbose output')
    parser.add_argument('--skip-existing', '-s', action='store_true', default=True,
                        help='Skip already downloaded files (default: True)')
    
    args = parser.parse_args()
    
    # Validate inputs
    if not args.url and not args.json:
        parser.error("Either URL or --json file is required")
    
    # Check cookies file
    if not os.path.exists(args.cookies):
        print_error(f"Cookies file not found: {args.cookies}")
        print_info("Please export cookies from your browser after logging in with Facebook")
        print_info("You can use a browser extension like 'EditThisCookie' to export cookies")
        sys.exit(1)
    
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print_header("DAFilms.cz Downloader")
    print_info(f"Output: {output_dir.absolute()}")
    print_info(f"Cookies: {args.cookies}")
    print_info(f"Quality: {args.quality.upper()}")
    
    if args.json:
        # Batch mode
        urls = load_urls_from_json(args.json)
        if not urls:
            print_error(f"No URLs found in {args.json}")
            sys.exit(1)
        
        print_info(f"Found {len(urls)} URLs in JSON")
        
        results = await process_batch(
            urls, output_dir, args.cookies,
            args.quality, args.force, args.dry_run,
            args.verbose, args.skip_existing
        )
        
        print_header("Results")
        print_success(f"Downloaded: {results['success']}")
        print_info(f"Skipped: {results['skipped']}")
        if results['failed'] > 0:
            print_error(f"Failed: {results['failed']}")
    
    else:
        # Single URL mode
        success, output_path = await download_video(
            args.url, output_dir, args.cookies,
            args.quality, args.force, args.dry_run, args.verbose
        )
        
        if success and not args.dry_run:
            print_header("Complete")
            print_success(f"Saved to: {output_path}")
        elif not success:
            sys.exit(1)


def main():
    asyncio.run(async_main())


if __name__ == '__main__':
    main()
