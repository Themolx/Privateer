# Privateer

Source code for web scraping and archival tools developed as part of the film work *Seed / Spider*.

---

## The Film

**Seed / Spider** visualizes the architecture of algorithmic recommendation through the act of web scraping itself. A crawler traverses a Czech streaming platform, each show appearing as a node in a growing network. The spider moves, links, captures. What appears is not content but the skeleton of its delivery. A portrait of attention infrastructure.

[View the film](https://martintomekvfx.github.io/work/scraping-the-internet)

---

The network structure references the original promise of decentralization, from which the contemporary internet is receding. Large platforms centralize but do not archive. The promise of a universal library for a monthly fee proves fragile. Content disappears, licenses expire, services shut down.

The source code of the scraper and visualization tool is part of the work. Data flows in the opposite direction. Each node in the network is also a reminder of the possibility of becoming an endpoint oneself. Not returning to the center, but building one's own archive. The film is a trace of this process.

---

## Platforms

Tools for retrieving and cataloging video content from:

| Platform | Country | Type | Tools |
|----------|---------|------|-------|
| **DAFilms.cz** | CZ | Documentary streaming | `dafilms_dl.py`, `dafilms_scraper.py` |
| **Artycok.tv** | CZ | Art and experimental video | `artycok_dl.py` |
| **OnePlay.cz** | CZ | Czech television content | `oneplay_dl.py` |
| **Ceska Televize** | CZ | Public broadcaster archive | `ct_batch_download.py` |
| **Nahnoji.cz** | CZ | Video hosting | `nahnoji.js` |
| **Prehrajto.cz** | CZ | Video hosting | `prehrajto.js` |
| **Archive.org** | US | Internet Archive | `archive-scraper.js`, `archive-org-scraper.js` |
| **NFB.ca** | CA | National Film Board of Canada | `nfb_download.py`, `nfb_index.py` |

---

## Repository Structure

```
downloaders/
    dafilms_dl.py           Documentary films from DAFilms.cz
    artycok_dl.py           Art video from Artycok.tv
    oneplay_dl.py           Czech streaming content
    ct_batch_download.py    Czech Television archive
    nfb_download.py         National Film Board of Canada

scrapers/
    dafilms_scraper.py      DAFilms catalog extraction
    archive-scraper.js      Archive.org traversal
    archive-org-scraper.js  Archive.org film search
    nfb_index.py            NFB catalog indexing
    prehrajto.js            Prehrajto.cz parser
    nahnoji.js              Nahnoji.cz parser

jellyfin-tools/
    tv-downloader.js        TV series download orchestrator
    smart-media-manager.js  Library organization and maintenance
    downloaders/            Platform-specific download modules

subtitle-tools/
    subtitle-fetcher.js     Czech subtitle retrieval
    titulky-fetcher.js      Titulky.com interface

utils/
    organize_library.py     Film categorization by duration
    smart-download.js       Intelligent download routing
```

---

## Requirements

### Python

```bash
pip install playwright requests yt-dlp
python -m playwright install chromium
```

### Node.js

```bash
npm install puppeteer axios cheerio
```

---

## Usage

Each tool operates independently. Configuration through command-line arguments or local files.

### Download

```bash
python dafilms_dl.py https://dafilms.cz/film/12345-title
python dafilms_dl.py --json films.json --output ./archive
```

### Scrape

```bash
node archive-scraper.js --search "czech animation"
python nfb_index.py --category animation
```

### Organize

```bash
python organize_library.py --json category.json --target animated
```

---

## On Archiving

Streaming interfaces present content as a neutral offering, but the structure of this offering is itself a curatorial gesture. These tools make that structure visible.

The spider does not distinguish between documentary and reality show, between original production and licensed format. Everything is an equivalent data point. What we choose to preserve is a different question.

---

## License

MIT License

---

## Disclaimer

These tools are provided for research and educational purposes only.

Respect the terms of service of each platform. Consider the labor of those who created the works you seek to preserve.
