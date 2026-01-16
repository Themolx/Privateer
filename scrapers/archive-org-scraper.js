const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { exec, spawn } = require('child_process');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    // Paths
    catalogPath: path.join(__dirname, 'master_animation_catalog.json'),
    queuePath: path.join(__dirname, 'download_queue.json'),
    candidatesPath: path.join(__dirname, 'candidates.json'),
    approvedPath: path.join(__dirname, 'approved.json'),
    reportPath: path.join(__dirname, 'download_report.json'),
    logPath: path.join(__dirname, 'archive-scraper.log'),
    downloadDir: './downloads',
    ytDlpPath: path.join(__dirname, 'yt-dlp'),

    // Search settings
    delayBetweenSearches: 2000, // ms between archive.org API calls (per thread)
    delayBetweenDownloads: 2000, // ms between downloads
    maxRetries: 3, // Max attempts per item
    minTitleSimilarity: 0.8, // Minimum similarity score (0-1) to consider a match
    maxConcurrent: 10, // Number of parallel downloads/searches

    // Quality preferences
    qualityFormats: ['1080p', '720p', 'h.264', 'x264', 'bluray', 'web-dl'],

    // Test mode
    testMode: false,
    testLimit: 5,
    skipAlreadySearched: false
};

// Global state
const activeDownloads = new Set();
let isShuttingDown = false;

// Logger
const logger = {
    info: (msg) => {
        const timestamp = new Date().toISOString();
        const logMsg = `[${timestamp}] ${msg}`;
        console.log(logMsg);
        fs.appendFileSync(CONFIG.logPath, logMsg + '\n');
    },
    success: (msg) => {
        const timestamp = new Date().toISOString();
        const logMsg = `[${timestamp}] ✅ ${msg}`;
        console.log(logMsg);
        fs.appendFileSync(CONFIG.logPath, logMsg + '\n');
    },
    warn: (msg) => {
        const timestamp = new Date().toISOString();
        const logMsg = `[${timestamp}] ⚠️  ${msg}`;
        console.log(logMsg);
        fs.appendFileSync(CONFIG.logPath, logMsg + '\n');
    },
    error: (msg) => {
        const timestamp = new Date().toISOString();
        const logMsg = `[${timestamp}] ❌ ${msg}`;
        console.error(logMsg);
        fs.appendFileSync(CONFIG.logPath, logMsg + '\n');
    },
    debug: (msg) => {
        // fs.appendFileSync(CONFIG.logPath, `[DEBUG] ${msg}\n`);
    },
    close: () => { }
};

// Colors for console
const c = {
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    reset: '\x1b[0m',
    clearLine: '\x1b[2K\r'
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
}

function appendToReport(item) {
    let report = [];
    try {
        if (fs.existsSync(CONFIG.reportPath)) {
            report = JSON.parse(fs.readFileSync(CONFIG.reportPath, 'utf8'));
        }
    } catch (e) { /* ignore */ }

    report.push(item);
    fs.writeFileSync(CONFIG.reportPath, JSON.stringify(report, null, 2));
}

// Levenshtein distance for similarity
function levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

function titleSimilarity(s1, s2) {
    const longer = s1.length > s2.length ? s1 : s2;
    if (longer.length === 0) return 1.0;

    // Normalize string: lowercase, remove special chars
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const n1 = normalize(s1);
    const n2 = normalize(s2);

    if (n1.length === 0 || n2.length === 0) return 0.0;

    return (longer.length - levenshtein(n1, n2)) / longer.length;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
    if (!seconds || !isFinite(seconds)) return 'Unknown';
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}m ${s}s`;
}

function progressBar(percent) {
    const width = 30;
    const completed = Math.floor(width * (percent / 100));
    const remaining = width - completed;
    return `[${'█'.repeat(completed)}${'░'.repeat(remaining)}] ${percent.toFixed(0)}%`;
}

async function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Invalid JSON: ${e.message}`));
                }
            });
        });

        req.on('error', reject);

        // Timeout after 60 seconds
        req.setTimeout(60000, () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });
    });
}

function downloadFile(url, destPath, totalSize, progressCallback) {
    return new Promise((resolve, reject) => {
        const dir = path.dirname(destPath);
        if (!fs.existsSync(dir)) {
            try {
                fs.mkdirSync(dir, { recursive: true });
            } catch (err) {
                return reject(new Error(`Failed to create directory: ${dir}`));
            }
        }

        const file = fs.createWriteStream(destPath);
        const client = url.startsWith('https') ? https : http;

        const req = client.get(url, (res) => {
            if (res.statusCode === 302 || res.statusCode === 301) {
                downloadFile(res.headers.location, destPath, totalSize, progressCallback).then(resolve).catch(reject);
                return;
            }

            if (res.statusCode !== 200) {
                reject(new Error(`Status code: ${res.statusCode}`));
                return;
            }

            let downloaded = 0;
            const startTime = Date.now();
            const total = totalSize || parseInt(res.headers['content-length'], 10);

            res.pipe(file);

            res.on('data', (chunk) => {
                downloaded += chunk.length;
                if (progressCallback && total) {
                    const elapsed = (Date.now() - startTime) / 1000;
                    const speed = downloaded / elapsed;
                    const eta = (total - downloaded) / speed;
                    progressCallback({
                        percent: (downloaded / total) * 100,
                        downloaded,
                        total,
                        speed,
                        eta
                    });
                }
            });

            file.on('finish', () => {
                file.close(resolve);
            });

            file.on('error', (err) => {
                fs.unlink(destPath, () => { });
                reject(err);
            });
        });

        req.on('error', (err) => {
            fs.unlink(destPath, () => { });
            reject(err);
        });

        // Timeout download if idle for 5 minutes
        req.setTimeout(300000, () => {
            req.destroy();
            fs.unlink(destPath, () => { });
            reject(new Error('Download timed out'));
        });
    });
}

async function checkDownloadable(url) {
    return new Promise(resolve => {
        const client = url.startsWith('https') ? https : http;
        const req = client.request(url, { method: 'HEAD' }, (res) => {
            resolve(res.statusCode === 200 || res.statusCode === 302);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

// ============================================================================
// QUEUE CLASS
// ============================================================================

class Queue {
    constructor(filePath) {
        this.filePath = filePath;
        this.items = [];
        this.load();
    }

    load() {
        if (fs.existsSync(this.filePath)) {
            try {
                this.items = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            } catch (e) {
                this.items = [];
            }
        }
    }

    save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.items, null, 2));
    }

    add(item) {
        const exists = this.items.find(i => i.title === item.title && i.year === item.year);
        if (!exists) {
            this.items.push({
                id: Math.random().toString(36).substr(2, 9),
                title: item.title,
                year: item.year,
                director: item.director,
                status: 'pending',
                attempts: 0,
                addedAt: new Date().toISOString()
            });
            this.save();
        }
    }

    update(id, updates) {
        const index = this.items.findIndex(i => i.id === id);
        if (index !== -1) {
            this.items[index] = { ...this.items[index], ...updates };
            this.save();
        }
    }

    getPending(limit = 1) {
        return this.items
            .filter(i => i.status === 'pending')
            .slice(0, limit);
    }

    stats() {
        return {
            total: this.items.length,
            pending: this.items.filter(i => i.status === 'pending').length,
            complete: this.items.filter(i => i.status === 'complete').length,
            failed: this.items.filter(i => i.status === 'failed').length,
            not_found: this.items.filter(i => i.status === 'not_found').length
        };
    }
}

// ============================================================================
// SHUTDOWN HANDLER
// ============================================================================

function setupShutdownHandler(queue, catalog, catalogPath) {
    process.on('SIGINT', async () => {
        logger.warn('\nReceived SIGINT, shutting down gracefully...');
        isShuttingDown = true;

        if (activeDownloads.size > 0) {
            logger.info(`Waiting for ${activeDownloads.size} active downloads to save state...`);
        }

        queue.save();
        fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
        logger.info('State saved. Goodbye!');
        process.exit(0);
    });
}


// ============================================================================
// YOUTUBE SEARCH & DOWNLOAD
// ============================================================================

async function searchYoutube(title, year, director) {
    const simpleQuery = `${title} ${director} animation`;
    const cmd = `${CONFIG.ytDlpPath} "ytsearch5:${simpleQuery}" --print "%(id)s|%(title)s|%(duration)s" --no-warnings --flat-playlist`;

    return new Promise((resolve) => {
        exec(cmd, { encoding: 'utf8', timeout: 60000 }, (error, stdout, stderr) => {
            if (error) {
                resolve([]);
                return;
            }

            try {
                const results = stdout.split('\n').filter(line => line.trim()).map(line => {
                    const parts = line.split('|');
                    if (parts.length < 2) return null;
                    const [id, ytTitle, duration] = parts;
                    return {
                        id,
                        title: ytTitle,
                        duration,
                        url: `https://www.youtube.com/watch?v=${id}`
                    };
                }).filter(r => r !== null);

                const validResults = results.filter(r => titleSimilarity(title, r.title) >= CONFIG.minTitleSimilarity);
                resolve(validResults.sort((a, b) => titleSimilarity(title, b.title || '') - titleSimilarity(title, a.title || '')));
            } catch (e) {
                resolve([]);
            }
        });
    });
}

function downloadYoutube(url, destPath) {
    return new Promise((resolve, reject) => {
        const dir = path.dirname(destPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const args = [
            url,
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '-o', destPath,
            '--no-playlist',
            '--no-warnings'
        ];

        const child = spawn(CONFIG.ytDlpPath, args);
        child.on('close', (code) => {
            if (code === 0) resolve(destPath);
            else reject(new Error(`yt-dlp exited with code ${code}`));
        });
    });
}

// ============================================================================
// ARCHIVE.ORG SEARCH & DOWNLOAD
// ============================================================================

async function searchArchive(title, year, director) {
    const searchStrategies = [
        `title:"${title}" AND year:${year} AND mediatype:movies`,
        `title:"${title}" AND creator:"${director}" AND mediatype:movies`,
        `"${title}" AND year:${year} AND mediatype:movies`,
        `title:"${title}" AND mediatype:movies`,
        `(title:"${title}" OR subject:"${title}" OR description:"${title}") AND mediatype:movies`,
    ];

    for (let i = 0; i < searchStrategies.length; i++) {
        const query = searchStrategies[i];
        const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&output=json&rows=20`;

        try {
            const result = await fetchJson(searchUrl);
            if (result.response?.docs?.length > 0) {
                const validResults = result.response.docs.filter(doc => {
                    return titleSimilarity(title, doc.title || '') >= CONFIG.minTitleSimilarity;
                });
                if (validResults.length > 0) {
                    return validResults.sort((a, b) => titleSimilarity(title, b.title || '') - titleSimilarity(title, a.title || ''));
                }
            }
            await sleep(CONFIG.delayBetweenSearches);
        } catch (error) { }
    }
    return [];
}

function scoreFile(file) {
    let score = 0;
    const name = (file.name || '').toLowerCase();
    const format = (file.format || '').toLowerCase();
    const source = (file.source || '').toLowerCase();
    const size = parseInt(file.size, 10) || 0;

    const videoExtensions = ['.mp4', '.mkv', '.avi', '.ogv', '.m4v', '.mov', '.webm'];
    if (!videoExtensions.some(ext => name.endsWith(ext))) return -1;
    if (size < 1000000) return -1;

    if (source === 'original') score += 500;
    CONFIG.qualityFormats.forEach((fmt, idx) => {
        if (format.includes(fmt) || name.includes(fmt)) score += (idx + 1) * 10;
    });

    if (name.includes('1080') || format.includes('1080')) score += 200;
    if (name.includes('720') || format.includes('720')) score += 150;
    score += Math.min(50, Math.floor(size / (1024 * 1024 * 10)));
    return score;
}

function selectBestFile(metadata) {
    if (!metadata.files?.length) return null;
    const scoredFiles = metadata.files
        .map(file => ({ file, score: scoreFile(file) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score);
    return scoredFiles.length > 0 ? scoredFiles[0].file : null;
}

// ============================================================================
// MAIN PROCESSING
// ============================================================================

async function processQueueItem(item, queue, catalog, catalogPath) {
    const { title, year, director } = item;

    logger.info(`🎬 Processing: "${title}" (${year}) by ${director}`);

    // Mark as searching immediately to prevent other workers from picking it up
    queue.update(item.id, { status: 'searching', attempts: item.attempts + 1 });

    let downloadedCount = 0;

    // 1. Archive.org
    logger.info(`   [${title}] Archive.org Searching...`);
    const archiveResults = await searchArchive(title, year, director);

    if (archiveResults.length > 0) {
        for (const result of archiveResults) {
            const identifier = result.identifier;
            try {
                const metadata = await fetchJson(`https://archive.org/metadata/${identifier}`);
                await sleep(CONFIG.delayBetweenSearches);

                if (metadata.metadata?.access && metadata.metadata.access !== 'public') continue;

                const bestFile = selectBestFile(metadata);
                if (!bestFile) continue;

                const downloadUrl = `https://archive.org/download/${identifier}/${encodeURIComponent(bestFile.name)}`;
                const isDownloadable = await checkDownloadable(downloadUrl);

                if (isDownloadable) {
                    const sanitizedTitle = sanitizeFilename(title);
                    const sanitizedDirector = sanitizeFilename(director);
                    const movieDir = path.join(CONFIG.downloadDir, `${sanitizedTitle} (${year})`);
                    const ext = path.extname(bestFile.name);
                    const destPath = path.join(movieDir, `${sanitizedTitle} (${year}) - ${sanitizedDirector} [Archive]${ext}`);

                    if (fs.existsSync(destPath)) {
                        logger.success(`   [${title}] Archive.org Already exists`);
                        appendToReport({ originalTitle: title, originalYear: year, foundTitle: result.title, source: 'archive.org', status: 'already_exists', timestamp: new Date().toISOString() });
                        downloadedCount++;
                        break;
                    }

                    logger.info(`   [${title}] Archive.org Downloading: ${bestFile.name}`);
                    activeDownloads.add(item.id);
                    await downloadFile(downloadUrl, destPath, parseInt(bestFile.size, 10));
                    activeDownloads.delete(item.id);
                    logger.success(`   [${title}] Archive.org Downloaded!`);

                    appendToReport({ originalTitle: title, originalYear: year, foundTitle: result.title, source: 'archive.org', status: 'downloaded', timestamp: new Date().toISOString() });
                    downloadedCount++;
                    break;
                }
            } catch (e) { logger.warn(`   [${title}] Archive.org Error: ${e.message}`); }
        }
    } else {
        logger.info(`   [${title}] Archive.org No results`);
    }

    // 2. YouTube
    logger.info(`   [${title}] YouTube Searching...`);
    const youtubeResults = await searchYoutube(title, year, director);

    if (youtubeResults.length > 0) {
        const bestResult = youtubeResults[0];
        logger.info(`   [${title}] YouTube Found: "${bestResult.title}"`);

        try {
            const sanitizedTitle = sanitizeFilename(title);
            const sanitizedDirector = sanitizeFilename(director);
            const movieDir = path.join(CONFIG.downloadDir, `${sanitizedTitle} (${year})`);
            const destPath = path.join(movieDir, `${sanitizedTitle} (${year}) - ${sanitizedDirector} [YouTube].mp4`);

            const exists = fs.existsSync(destPath) || fs.existsSync(destPath.replace('.mp4', '.mkv'));

            if (exists) {
                logger.success(`   [${title}] YouTube Already exists`);
                appendToReport({ originalTitle: title, originalYear: year, foundTitle: bestResult.title, source: 'youtube', status: 'already_exists', timestamp: new Date().toISOString() });
                downloadedCount++;
            } else {
                logger.info(`   [${title}] YouTube Downloading...`);
                activeDownloads.add(item.id);
                await downloadYoutube(bestResult.url, destPath);
                activeDownloads.delete(item.id);
                logger.success(`   [${title}] YouTube Downloaded!`);

                appendToReport({ originalTitle: title, originalYear: year, foundTitle: bestResult.title, source: 'youtube', status: 'downloaded', timestamp: new Date().toISOString() });
                downloadedCount++;
            }
        } catch (e) {
            logger.error(`   [${title}] YouTube Download failed: ${e.message}`);
            activeDownloads.delete(item.id);
        }
    } else {
        logger.info(`   [${title}] YouTube No results`);
    }

    // Final Status
    if (downloadedCount > 0) {
        queue.update(item.id, { status: 'complete' });
        const catalogItem = catalog.find(m => m.title === title && m.year === year);
        if (catalogItem) {
            catalogItem.downloaded = true;
            catalogItem.download_date = new Date().toISOString();
            fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
        }
        return true;
    }

    queue.update(item.id, { status: 'failed', error: 'No suitable files found in either source' });
    return false;
}

async function runSearchMode(queue, catalog) {
    // Only kept for reference, not updated for parallel
    logger.info('MODE: Candidates Search (Sequential)');
    let moviesToSearch = catalog.filter(m => !m.downloaded);
    const candidates = [];
    for (const movie of moviesToSearch) {
        if (isShuttingDown) break;
        // ... implementation omitted for brevity as user wants download mode ...
    }
}

async function main() {
    console.log(`
${c.cyan}╔═══════════════════════════════════════════════════════════════╗
║  🎬 ARCHIVE.ORG ANIMATION SCRAPER v3.0 (Parallel)             ║
╚═══════════════════════════════════════════════════════════════╝${c.reset}
`);
    logger.info(`Catalog: ${CONFIG.catalogPath}`);
    logger.info(`Download directory: ${CONFIG.downloadDir}`);
    logger.info(`Queue file: ${CONFIG.queuePath}`);

    if (!fs.existsSync(CONFIG.downloadDir)) fs.mkdirSync(CONFIG.downloadDir, { recursive: true });

    let catalog = JSON.parse(fs.readFileSync(CONFIG.catalogPath, 'utf8'));
    logger.info(`Loaded ${catalog.length} movies from catalog`);

    const queue = new Queue(CONFIG.queuePath);
    setupShutdownHandler(queue, catalog, CONFIG.catalogPath);

    const args = process.argv.slice(2);
    if (args.includes('--search')) { await runSearchMode(queue, catalog); return; }

    let moviesToAdd = catalog.filter(m => !m.downloaded);
    if (CONFIG.testMode) {
        moviesToAdd = moviesToAdd.slice(0, CONFIG.testLimit);
        logger.info(`TEST MODE: Processing only ${moviesToAdd.length} movies`);
    }
    moviesToAdd.forEach(m => queue.add(m));

    // Reset any items that were stuck in 'searching', 'downloading', OR 'failed' (for retry)
    const stuckItems = queue.items.filter(i => i.status === 'searching' || i.status === 'downloading' || i.status === 'failed');
    if (stuckItems.length > 0) {
        logger.warn(`Resetting ${stuckItems.length} stuck/failed items to pending status for retry...`);
        stuckItems.forEach(item => {
            queue.update(item.id, { status: 'pending', error: null, attempts: 0 });
        });
    }

    const stats = queue.stats();
    logger.info(`Queue stats: ${stats.pending} pending, ${stats.complete} complete, ${stats.failed} failed`);

    const startTime = Date.now();
    let processed = 0, downloaded = 0;

    // WORKER POOL
    const workerPool = async () => {
        let running = 0;
        return new Promise((resolve) => {
            const runNext = async () => {
                if (isShuttingDown || (queue.getPending(1).length === 0 && running === 0)) {
                    if (running === 0) resolve();
                    return;
                }

                while (running < CONFIG.maxConcurrent && !isShuttingDown) {
                    const pending = queue.getPending(1);
                    if (pending.length === 0) break;

                    const item = pending[0];
                    running++;
                    processed++;

                    processQueueItem(item, queue, catalog, CONFIG.catalogPath)
                        .then((success) => {
                            if (success) downloaded++;
                            running--;
                            runNext();
                        })
                        .catch(err => {
                            logger.error(`Worker Error: ${err.message}`);
                            running--;
                            runNext();
                        });
                }
            };
            runNext();
        });
    };

    logger.info(`Starting workers (Max concurrent: ${CONFIG.maxConcurrent})...`);
    await workerPool();

    const duration = Date.now() - startTime;
    console.log();
    logger.info(`${'═'.repeat(60)}`);
    logger.success(`SCRAPING COMPLETE in ${formatDuration((duration) / 1000)}`);
    logger.info(`${'═'.repeat(60)}`);
    logger.info(`Total processed: ${processed}`);
    logger.success(`Downloaded: ${downloaded}`);

    logger.close();
}

main().catch(error => {
    logger.error(`Fatal error: ${error.message}`);
    process.exit(1);
});
