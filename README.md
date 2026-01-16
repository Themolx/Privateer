# Archive Tools

A collection of instruments for the preservation of moving images.

---

```
"The cinema is truth twenty-four times per second."
                                    — Jean-Luc Godard
```

---

## On Digital Preservation

These tools emerged from a simple necessity: to gather, organize, and preserve
video content that exists in the ephemeral space of streaming platforms. What
streams today may vanish tomorrow. What plays now may never play again.

The digital archive is not a static repository but a living practice — a ritual
of selection, retrieval, and arrangement. Each script in this collection serves
as a small gesture toward permanence in a medium defined by its transience.

---

## The Instruments

### Downloaders

Scripts for retrieving video content from Czech streaming platforms.

| Tool | Platform | Purpose |
|------|----------|---------|
| `dafilms_dl.py` | DAFilms.cz | Documentary films |
| `artycok_dl.py` | Artycok.tv | Art and experimental video |
| `oneplay_dl.py` | OnePlay.cz | Czech television content |
| `ct_batch_download.py` | iVysilani | Czech Television archive |

### Scrapers

Tools for discovering and cataloging available content.

| Tool | Function |
|------|----------|
| `dafilms_scraper.py` | Extract film listings from DAFilms |
| `prehrajto.js` | Navigate streaming directories |
| `nahnoji.js` | Parse video hosting structures |

### Jellyfin Tools

Integration layer for personal media servers.

| Tool | Purpose |
|------|---------|
| `tv-downloader.js` | Orchestrate TV series downloads |
| `smart-media-manager.js` | Organize and maintain libraries |
| `subtitle-fetcher.js` | Retrieve Czech subtitles |
| `titulky-fetcher.js` | Interface with titulky.com |

### Utilities

| Tool | Purpose |
|------|---------|
| `organize_library.py` | Sort films by category |

---

## Requirements

### Python Tools

```
playwright
requests
yt-dlp
```

Install with:
```bash
pip install playwright requests yt-dlp
python -m playwright install chromium
```

### JavaScript Tools

```bash
npm install puppeteer axios cheerio
```

---

## Configuration

Each tool reads from local configuration. Before first use:

1. Create a `cookies.txt` file with your session cookies
2. Set output directory via `--output` or edit defaults in script
3. Prepare URL lists in JSON format

### Cookie Format

Export cookies from your browser using any cookie export extension.
The file should follow Netscape cookie format or JSON array structure.

### URL List Format

```json
[
  {"url": "https://example.com/film/123-title"},
  {"url": "https://example.com/film/456-another"}
]
```

---

## Usage Patterns

### Single Retrieval

```bash
python dafilms_dl.py https://dafilms.cz/film/12345-title
```

### Batch Processing

```bash
python dafilms_dl.py --json films.json --output ./archive
```

### Dry Run

Preview without downloading:
```bash
python dafilms_dl.py --json films.json --dry-run
```

### Jellyfin TV Series

```bash
node tv-downloader.js --list
node tv-downloader.js --show series-name --output ./library
```

---

## On Organization

Films are sorted by duration into categories:

- **shorts/** — works of 40 minutes or fewer
- **features/** — works exceeding 40 minutes

Directory structure follows Jellyfin conventions:

```
archive/
  shorts/
    Title (Year) - Director/
      Title (Year) - Director.mp4
      Title (Year) - Director.nfo
  features/
    Title (Year) - Director/
      Title (Year) - Director.mp4
      Title (Year) - Director.nfo
```

---

## Provenance

Developed as part of an archival practice at CAS FAMU, Prague.

These tools are offered without warranty, as instruments for those engaged
in the work of preservation. Use them with care and consideration for the
labor of those who created the works you seek to preserve.

---

## License

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files, to deal in the software
without restriction, including without limitation the rights to use, copy,
modify, merge, publish, distribute, sublicense, and/or sell copies of the
software, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the software.

---

```
"Film is a battleground."
              — Samuel Fuller
```
