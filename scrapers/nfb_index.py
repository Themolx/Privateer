#!/usr/bin/env python3
"""
NFB Animation Indexer
Uses Playwright to scrape all free animation films from NFB (handles JavaScript).

Usage:
    python nfb_index.py                      # Index all free animations
    python nfb_index.py --output mylist.txt  # Custom output file
    python nfb_index.py --limit 100          # Only get first 100 films
"""

import argparse
import re
import sys
import time

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("❌ Missing Playwright. Install with:")
    print("   pip install playwright && playwright install chromium")
    sys.exit(1)


BASE_URL = "https://www.nfb.ca"
EXPLORE_URL = "https://www.nfb.ca/explore-all-films/?language=en&availability=free&genre=animation&sort_order=popular"


def extract_film_urls(page_content: str) -> set:
    """Extract film URLs from page HTML."""
    pattern = r'href="(/film/[^"]+)"'
    matches = re.findall(pattern, page_content)
    return {BASE_URL + href for href in matches}


def index_animations(output_file: str = "nfb_animations.txt", limit: int = None, target: int = 990) -> list:
    """
    Index all free animation films from NFB using Playwright.
    """
    all_urls = set()
    
    print(f"🎬 Indexing NFB free animation films...")
    print(f"   Target: ~{target} films")
    print(f"   Starting browser...")
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        
        # Load the page
        page.goto(EXPLORE_URL, wait_until="networkidle")
        time.sleep(3)
        
        # Get initial films
        content = page.content()
        urls = extract_film_urls(content)
        all_urls.update(urls)
        print(f"   Loaded {len(all_urls)} films...")
        
        # Keep clicking "More films" button until we have all films
        stall_count = 0
        max_stalls = 5
        
        while len(all_urls) < target:
            if limit and len(all_urls) >= limit:
                break
            
            last_count = len(all_urls)
            
            # Find and click the "More films" button
            more_button = page.query_selector(".nfb-more__link")
            if not more_button:
                print(f"   No 'More films' button found, stopping at {len(all_urls)}")
                break
            
            # Scroll to button and click it
            more_button.scroll_into_view_if_needed()
            more_button.click()
            time.sleep(2)
            
            # Wait for new content to load
            try:
                page.wait_for_load_state("networkidle", timeout=10000)
            except:
                pass
            
            # Extract new URLs
            content = page.content()
            urls = extract_film_urls(content)
            all_urls.update(urls)
            
            # Check progress
            if len(all_urls) > last_count:
                print(f"   Loaded {len(all_urls)} films...")
                stall_count = 0
            else:
                stall_count += 1
                if stall_count >= max_stalls:
                    print(f"   No more films loading, stopping at {len(all_urls)}")
                    break
        
        browser.close()
    
    # Apply limit if specified
    all_urls = sorted(list(all_urls))
    if limit:
        all_urls = all_urls[:limit]
    
    # Save to file
    with open(output_file, 'w') as f:
        for url in all_urls:
            f.write(url + '\n')
    
    print(f"\n✅ Indexed {len(all_urls)} films")
    print(f"📁 Saved to: {output_file}")
    
    return all_urls


def main():
    parser = argparse.ArgumentParser(description="Index NFB free animation films")
    parser.add_argument("--output", "-o", default="nfb_animations.txt", 
                        help="Output file for URLs (default: nfb_animations.txt)")
    parser.add_argument("--limit", "-l", type=int, 
                        help="Maximum number of films to index")
    parser.add_argument("--target", "-t", type=int, default=990,
                        help="Expected total number of films (default: 990)")
    
    args = parser.parse_args()
    
    index_animations(args.output, args.limit, args.target)


if __name__ == "__main__":
    main()
