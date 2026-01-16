#!/usr/bin/env python3
"""
DAFilms.cz Scraper - Scrape film listings from dafilms.cz sections

Indexes all films from a DAFilms section (e.g., animated films) and outputs JSON.
Uses Playwright for browser automation to handle pagination.

Usage:
    python3 dafilms_scraper.py "https://dafilms.cz/film?f=cl-19&o=r"
    python3 dafilms_scraper.py "https://dafilms.cz/film?f=cl-19&o=r" --output animated.json
    python3 dafilms_scraper.py "https://dafilms.cz/film?f=cl-19&o=r" --pages 2
"""

import argparse
import json
import sys
import time
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("Error: playwright is required. Install with: pip install playwright")
    print("Then run: playwright install chromium")
    sys.exit(1)


# ============================================================================
# CONFIGURATION
# ============================================================================

MAX_RETRIES = 3
RETRY_DELAY = 3  # seconds
PAGE_TIMEOUT = 30000  # 30 seconds


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
    print(f"\n{Colors.BOLD}{Colors.HEADER}{'='*60}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.HEADER}{text}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.HEADER}{'='*60}{Colors.RESET}\n")


def print_success(text: str):
    print(f"{Colors.GREEN}✓ {text}{Colors.RESET}")


def print_error(text: str):
    print(f"{Colors.RED}✗ {text}{Colors.RESET}")


def print_warning(text: str):
    print(f"{Colors.YELLOW}⚠ {text}{Colors.RESET}")


def print_info(text: str):
    print(f"{Colors.CYAN}ℹ {text}{Colors.RESET}")


def print_progress(current: int, total: int, text: str):
    bar_width = 30
    filled = int(bar_width * current / total) if total > 0 else 0
    bar = '█' * filled + '░' * (bar_width - filled)
    print(f"\r{Colors.BLUE}[{bar}] {current}/{total} {text}{Colors.RESET}", end='', flush=True)


# ============================================================================
# URL HELPERS
# ============================================================================

def add_page_param(url: str, page: int) -> str:
    """Add or update page parameter in URL."""
    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    params['page'] = [str(page)]
    new_query = urlencode(params, doseq=True)
    return urlunparse(parsed._replace(query=new_query))


# ============================================================================
# SCRAPER
# ============================================================================

def scrape_page(page, url: str) -> list[dict]:
    """Scrape all film URLs from a single page with retry logic."""
    for attempt in range(MAX_RETRIES):
        try:
            page.goto(url, wait_until='networkidle', timeout=PAGE_TIMEOUT)
            
            # Wait for film cards to load
            page.wait_for_selector('.ui-movie-card', timeout=PAGE_TIMEOUT)
            
            # Small delay to ensure page is fully rendered
            time.sleep(0.5)
            
            # Extract film URLs
            films = []
            cards = page.query_selector_all('.ui-movie-card')
            
            for card in cards:
                link_element = card.query_selector('.ui-movie-card__link--title')
                if link_element:
                    href = link_element.get_attribute('href')
                    if href:
                        # Make absolute URL if relative
                        if href.startswith('/'):
                            href = f"https://dafilms.cz{href}"
                        films.append({"url": href})
            
            return films
            
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                print()  # New line for warning
                print_warning(f"Attempt {attempt + 1} failed on {url}, retrying in {RETRY_DELAY}s...")
                time.sleep(RETRY_DELAY)
            else:
                print()  # New line for error
                print_error(f"Failed after {MAX_RETRIES} attempts: {e}")
                return []  # Return empty list instead of crashing
    
    return []


def get_total_pages(page) -> int:
    """Detect total number of pages from pagination."""
    pagination_links = page.query_selector_all('.pagination a')
    max_page = 1
    
    for link in pagination_links:
        href = link.get_attribute('href')
        if href and 'page=' in href:
            try:
                # Extract page number from URL
                parsed = urlparse(href)
                params = parse_qs(parsed.query)
                if 'page' in params:
                    page_num = int(params['page'][0])
                    max_page = max(max_page, page_num)
            except (ValueError, IndexError):
                continue
    
    return max_page


def scrape_section(base_url: str, max_pages: int = None, headless: bool = True) -> list[dict]:
    """Scrape all films from a DAFilms section."""
    all_films = []
    failed_pages = []
    
    print_header("DAFilms Scraper")
    print_info(f"Starting URL: {base_url}")
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context()
        page = context.new_page()
        
        # First page - detect total pages
        print_info("Loading first page...")
        first_page_films = scrape_page(page, base_url)
        all_films.extend(first_page_films)
        
        total_pages = get_total_pages(page)
        if max_pages:
            total_pages = min(total_pages, max_pages)
        
        print_success(f"Found {len(first_page_films)} films on page 1")
        print_info(f"Total pages to scrape: {total_pages}")
        
        # Remaining pages
        for page_num in range(2, total_pages + 1):
            print_progress(page_num, total_pages, f"Scraping page {page_num}...")
            
            page_url = add_page_param(base_url, page_num)
            page_films = scrape_page(page, page_url)
            
            if page_films:
                all_films.extend(page_films)
            else:
                failed_pages.append(page_num)
            
            # Small delay between pages to avoid rate limiting
            time.sleep(0.5)
        
        print()  # New line after progress bar
        browser.close()
    
    print_success(f"Total films scraped: {len(all_films)}")
    
    if failed_pages:
        print_warning(f"Failed pages: {failed_pages}")
    
    return all_films


# ============================================================================
# MAIN
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description='Scrape film listings from DAFilms.cz sections',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  %(prog)s "https://dafilms.cz/film?f=cl-19&o=r"
  %(prog)s "https://dafilms.cz/film?f=cl-19&o=r" --output animated.json
  %(prog)s "https://dafilms.cz/film?f=cl-19&o=r" --pages 2
        '''
    )
    
    parser.add_argument('url', help='DAFilms section URL to scrape')
    parser.add_argument('-o', '--output', help='Output JSON file (default: stdout)')
    parser.add_argument('-p', '--pages', type=int, help='Max pages to scrape (default: all)')
    parser.add_argument('--no-headless', action='store_true', help='Show browser window')
    
    args = parser.parse_args()
    
    # Validate URL
    if 'dafilms.cz' not in args.url:
        print_error("URL must be a dafilms.cz URL")
        sys.exit(1)
    
    # Scrape
    films = scrape_section(
        base_url=args.url,
        max_pages=args.pages,
        headless=not args.no_headless
    )
    
    # Output
    json_output = json.dumps(films, indent=2, ensure_ascii=False)
    
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(json_output)
        print_success(f"Saved to {args.output}")
    else:
        print("\n" + json_output)


if __name__ == '__main__':
    main()
