#!/usr/bin/env python3
"""
Organize DAFilms downloads into separate libraries.

This script reads a JSON file (like animated.json) and moves matching films
from the main download directory into a subdirectory (e.g., 'animated/').

This allows creating separate Jellyfin libraries for different categories.

Usage:
    python organize_animated.py                    # Default: use animated.json
    python organize_animated.py --json other.json  # Use different JSON
    python organize_animated.py --dry-run          # Preview without moving
"""

import argparse
import json
import os
import re
import shutil
from pathlib import Path
from typing import List, Set, Dict

# Configuration
DEFAULT_JSON = "./animated.json"
DAFILMS_DIR = Path("./downloads")


def extract_film_id(url: str) -> str:
    """Extract film ID from DAFilms URL.
    
    Example: https://dafilms.cz/film/12836-modern-times -> 12836-modern-times
    """
    match = re.search(r'/film/([^/]+)$', url)
    if match:
        return match.group(1)
    return ""


def extract_numeric_id(film_id: str) -> str:
    """Extract just the numeric part of film ID.
    
    Example: 12836-modern-times -> 12836
    """
    match = re.match(r'^(\d+)', film_id)
    if match:
        return match.group(1)
    return ""


def load_animated_ids(json_path: str) -> Set[str]:
    """Load film IDs from JSON file."""
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    ids = set()
    for item in data:
        url = item.get('url', '') if isinstance(item, dict) else item
        film_id = extract_film_id(url)
        if film_id:
            ids.add(film_id)
            # Also add just the numeric ID for matching
            numeric_id = extract_numeric_id(film_id)
            if numeric_id:
                ids.add(numeric_id)
    
    return ids


def find_matching_folders(base_dir: Path, film_ids: Set[str]) -> List[Path]:
    """Find folders that match any of the film IDs.
    
    Folders are named like: Title (Year) - Director
    We need to match by checking if any film ID appears in folder contents
    or by reading the NFO file which contains the source URL.
    """
    matching = []
    
    # Check both shorts and features subdirectories, plus root
    search_dirs = [base_dir]
    if (base_dir / "shorts").exists():
        search_dirs.append(base_dir / "shorts")
    if (base_dir / "features").exists():
        search_dirs.append(base_dir / "features")
    
    for search_dir in search_dirs:
        for folder in search_dir.iterdir():
            if not folder.is_dir():
                continue
            
            # Skip the target directory itself
            if folder.name == "animated":
                continue
            
            # Check NFO file for source URL
            nfo_files = list(folder.glob("*.nfo"))
            for nfo_file in nfo_files:
                try:
                    content = nfo_file.read_text(encoding='utf-8')
                    # Look for dafilms URL in NFO
                    url_match = re.search(r'https://dafilms\.cz/film/([^<\s]+)', content)
                    if url_match:
                        found_id = url_match.group(1)
                        numeric_id = extract_numeric_id(found_id)
                        if found_id in film_ids or numeric_id in film_ids:
                            matching.append(folder)
                            break
                except Exception:
                    continue
    
    return matching


def move_folders(folders: List[Path], target_dir: Path, dry_run: bool = False) -> Dict[str, List[str]]:
    """Move folders to target directory, preserving shorts/features structure."""
    results = {"moved": [], "errors": [], "skipped": []}
    
    target_dir.mkdir(parents=True, exist_ok=True)
    
    for folder in folders:
        # Determine the category (shorts or features) from the source path
        parent_name = folder.parent.name
        if parent_name in ("shorts", "features"):
            # Preserve the category structure
            category_dir = target_dir / parent_name
            category_dir.mkdir(parents=True, exist_ok=True)
            dest = category_dir / folder.name
        else:
            # No category, put directly in target
            dest = target_dir / folder.name
        
        if dest.exists():
            results["skipped"].append(f"{folder.name} (already exists)")
            continue
        
        try:
            if dry_run:
                results["moved"].append(f"{folder} -> {dest}")
            else:
                shutil.move(str(folder), str(dest))
                results["moved"].append(folder.name)
        except Exception as e:
            results["errors"].append(f"{folder.name}: {e}")
    
    return results


def main():
    parser = argparse.ArgumentParser(
        description='Organize DAFilms downloads into separate libraries',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    %(prog)s                           # Move animated films to animated/
    %(prog)s --dry-run                 # Preview what would be moved
    %(prog)s --json experimental.json  # Use different category JSON
    %(prog)s --target experimental     # Move to experimental/ instead
        """
    )
    
    parser.add_argument('--json', default=DEFAULT_JSON,
                        help='JSON file with film URLs to categorize')
    parser.add_argument('--base-dir', default=str(DAFILMS_DIR),
                        help='Base DAFilms download directory')
    parser.add_argument('--target', default='animated',
                        help='Target subdirectory name')
    parser.add_argument('--dry-run', action='store_true',
                        help='Preview changes without moving files')
    
    args = parser.parse_args()
    
    base_dir = Path(args.base_dir)
    target_dir = base_dir / args.target
    
    print(f"\n{'='*60}")
    print(f"  DAFilms Library Organizer")
    print(f"{'='*60}\n")
    
    print(f"  📁 Base directory: {base_dir}")
    print(f"  📄 JSON file: {args.json}")
    print(f"  📂 Target: {target_dir}")
    print(f"  🔍 Mode: {'DRY RUN' if args.dry_run else 'LIVE'}")
    print()
    
    # Load film IDs from JSON
    print("Loading film IDs from JSON...")
    film_ids = load_animated_ids(args.json)
    print(f"  Found {len(film_ids)} film IDs\n")
    
    # Find matching folders
    print("Scanning for matching folders...")
    matching = find_matching_folders(base_dir, film_ids)
    print(f"  Found {len(matching)} matching folders\n")
    
    if not matching:
        print("No matching folders found.")
        return
    
    # Show what will be moved
    print("Folders to move:")
    for folder in matching[:10]:
        print(f"  • {folder.name}")
    if len(matching) > 10:
        print(f"  ... and {len(matching) - 10} more")
    print()
    
    # Move folders
    if args.dry_run:
        print("DRY RUN - No files will be moved.\n")
    
    results = move_folders(matching, target_dir, args.dry_run)
    
    # Print results
    print(f"\n{'='*60}")
    print(f"  Results")
    print(f"{'='*60}\n")
    
    print(f"  ✓ Moved: {len(results['moved'])}")
    print(f"  ⏭ Skipped: {len(results['skipped'])}")
    print(f"  ✗ Errors: {len(results['errors'])}")
    
    if results['errors']:
        print("\nErrors:")
        for error in results['errors']:
            print(f"  • {error}")
    
    print()


if __name__ == '__main__':
    main()
