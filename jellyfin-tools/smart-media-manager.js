#!/usr/bin/env node
/**
 * 🚀 SMART MEDIA MANAGER v2.1
 * 
 * The Ultimate Self-Healing Jellyfin Downloader
 * - Unified Movies & TV Shows Queue
 * - Parallel Downloads with Progress
 * - Auto-Resume & Smart Retry (handles curl drops)
 * - Broken File Scanner & Auto-Requeue
 * - Multi-Location Inventory Check
 * - Wanted List Integration
 * - Disk Space Monitoring
 * - Graceful shutdown & logging
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { downloadFromPrehrajto } from './downloaders/prehrajto.js';
import { downloadFromNahnoji } from './downloaders/nahnoji.js';
import { searchPrehrajto } from './crawlers/crawl-prehrajto.js';
import * as subtitleFetcher from './subtitle-fetcher.js';
import * as titulkyFetcher from './titulky-fetcher.js';
import { clearLine, cursorTo } from 'readline';
const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// OpenSubtitles Integration
import { scanAll as fetchSubtitles, getStatus as getSubtitleStatus } from './opensubtitles-fetcher.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    // Storage Locations
    MOVIE_DIR: './downloads',
    TV_DIR: './downloads',
    SHOWS_DIR: path.join(__dirname, 'shows'),
    WANTED_FILE: path.join(__dirname, 'wanted_movies.json'),

    // Alternate locations to check before downloading
    ALTERNATE_ROOTS: [
        './downloads',
        './downloads',
        './downloads'
    ],

    // Queue Persistence
    QUEUE_FILE: path.join(__dirname, 'queue.json'),
    LOG_FILE: path.join(__dirname, 'smart-media-manager.log'),

    // Download Settings
    PARALLEL_LIMIT: 2,
    MAX_RETRIES: 10,
    RETRY_DELAY_BASE_MS: 5000,
    MIN_SIZE_BYTES: 10 * 1024 * 1024,  // 10MB
    MIN_DISK_SPACE_GB: 5,
    OPENSUBTITLES_API_KEY: process.env.OPENSUBTITLES_API_KEY || '1djfcGodUigewRay7RxibwqvVwqhB9lc', // Default key or from env

    // Files to IGNORE in scanner
    IGNORE_EXTENSIONS: ['.nfo', '.srt', '.vtt', '.sub', '.idx', '.txt', '.jpg', '.png', '.gif'],

    // Show aliases
    SHOW_ALIASES: {
        'Griffinovi': 'Family Guy',
        'Pratele': 'Friends',
        'Teorie velkeho tresku': 'The Big Bang Theory',
        'Jak jsem poznal vasi matku': 'How I Met Your Mother',
        'Simpsonovi': 'The Simpsons',
        'Futurama': 'Futurama',
        'South Park': 'South Park',
        'Rick a Morty': 'Rick and Morty'
    },

    // Shows to SKIP (don't download right now)
    SKIP_SHOWS: ['Friends', 'Pratele', 'The Simpsons', 'Simpsonovi'],

    // Reporting settings
    STATS_THROTTLE_MS: 10000,  // Only print stats every 10 seconds

    // Quality Profiles (MB)
    QUALITY_PROFILES: {
        high: { min: 1000, max: 8000, target: 3000 },
        medium: { min: 400, max: 1500, target: 800 },
        low: { min: 0, max: 600, target: 350 }
    }
};

// ============================================================================
// ANSI COLORS & LOGGING
// ============================================================================

const c = {
    reset: '\x1b[0m', bold: '\x1b[1m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
    cyan: '\x1b[36m', gray: '\x1b[90m', magenta: '\x1b[35m',
    clearLine: '\x1b[2K\r'
};

// Logger with file support
class Logger {
    constructor(logFile) {
        this.logFile = logFile;
        this.logStream = null;
        try {
            this.logStream = fs.createWriteStream(logFile, { flags: 'a' });
        } catch (e) { /* ignore */ }
    }

    log(msg, color = '') {
        const timestamp = new Date().toISOString();
        const cleanMsg = msg.replace(/\x1b\[[0-9;]*m/g, ''); // Strip ANSI for file
        console.log(`${color}${msg}${c.reset}`);
        if (this.logStream) {
            this.logStream.write(`[${timestamp}] ${cleanMsg}\n`);
        }
    }

    close() {
        if (this.logStream) this.logStream.end();
    }
}

const logger = new Logger(CONFIG.LOG_FILE);
function log(msg, color = '') { logger.log(msg, color); }

function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec <= 0) return '-- MB/s';
    const mbps = bytesPerSec / (1024 * 1024);
    return `${mbps.toFixed(2)} MB/s`;
}

// Normalize name for matching - transliterate diacritics instead of removing them
function normalizeName(str) {
    // Czech and common diacritics transliteration
    const diacriticsMap = {
        'á': 'a', 'č': 'c', 'ď': 'd', 'é': 'e', 'ě': 'e', 'í': 'i', 'ň': 'n',
        'ó': 'o', 'ř': 'r', 'š': 's', 'ť': 't', 'ú': 'u', 'ů': 'u', 'ý': 'y', 'ž': 'z',
        'Á': 'a', 'Č': 'c', 'Ď': 'd', 'É': 'e', 'Ě': 'e', 'Í': 'i', 'Ň': 'n',
        'Ó': 'o', 'Ř': 'r', 'Š': 's', 'Ť': 't', 'Ú': 'u', 'Ů': 'u', 'Ý': 'y', 'Ž': 'z',
        // German/other common
        'ä': 'a', 'ö': 'o', 'ü': 'u', 'ß': 'ss', 'Ä': 'a', 'Ö': 'o', 'Ü': 'u',
        // French/Spanish
        'à': 'a', 'â': 'a', 'è': 'e', 'ê': 'e', 'ë': 'e', 'î': 'i', 'ï': 'i',
        'ô': 'o', 'ù': 'u', 'û': 'u', 'ç': 'c', 'ñ': 'n'
    };

    let result = str.toLowerCase();
    for (const [diacritic, ascii] of Object.entries(diacriticsMap)) {
        result = result.split(diacritic.toLowerCase()).join(ascii);
    }
    // Remove remaining non-alphanumeric
    return result.replace(/[^a-z0-9]/g, '');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function checkDiskSpace(dir) {
    try {
        const { stdout } = await execAsync(`df -g "${dir}" | tail -1 | awk '{print $4}'`);
        return parseInt(stdout.trim(), 10) || 0;
    } catch (e) { return 0; }
}

function shouldIgnoreFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    // Also ignore Apple Double files (._*)
    if (filename.startsWith('._')) return true;
    return CONFIG.IGNORE_EXTENSIONS.includes(ext);
}

function progressBar(percent, width = 30) {
    const filled = Math.round(width * percent / 100);
    const empty = width - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent.toFixed(1)}%`;
}

// ============================================================================
// GRACEFUL SHUTDOWN HANDLER
// ============================================================================

let isShuttingDown = false;
let activeDownloads = new Map(); // Track active downloads for cleanup

function setupShutdownHandler(queue) {
    const shutdown = async (signal) => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        log(`\n⚠️  Received ${signal}, shutting down gracefully...`, c.yellow);

        // Mark downloading items as pending so they can resume
        for (const [id, item] of activeDownloads) {
            queue.update(id, { status: 'pending', lastError: 'Interrupted by user' });
            log(`   💾 Saved state for: ${item.title}`, c.gray);

            // Clean up temp files
            const tempPath = item.outputPath + '.temp.mp4';
            if (fs.existsSync(tempPath)) {
                try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
            }
        }

        queue.save();
        log(`✅ Queue saved. Run again to resume.`, c.green);
        logger.close();
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ============================================================================
// QUEUE CLASS
// ============================================================================

class Queue {
    constructor(filepath) {
        this.filepath = filepath;
        this.items = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.filepath)) {
                this.items = JSON.parse(fs.readFileSync(this.filepath, 'utf-8'));
            }
        } catch (e) {
            this.items = [];
        }
    }

    save() {
        fs.writeFileSync(this.filepath, JSON.stringify(this.items, null, 2));
    }

    add(item) {
        if (this.items.find(i => i.outputPath === item.outputPath)) {
            return false;
        }
        this.items.push({
            id: Date.now() + Math.random().toString(36).substr(2, 5),
            status: 'pending',
            retries: 0,
            errors: [],  // Error history
            addedAt: new Date().toISOString(),
            ...item
        });
        this.save();
        return true;
    }

    getPending(limit = 1) {
        return this.items.filter(i => i.status === 'pending').slice(0, limit);
    }

    getRetrying() {
        return this.items.filter(i => i.status === 'retrying');
    }

    update(id, updates) {
        const idx = this.items.findIndex(i => i.id === id);
        if (idx !== -1) {
            this.items[idx] = { ...this.items[idx], ...updates };
            this.save();
        }
    }

    markComplete(id, size) {
        this.update(id, { status: 'completed', completedAt: new Date().toISOString(), size });
    }

    markFailed(id, error) {
        const item = this.items.find(i => i.id === id);
        if (item) {
            item.retries++;
            item.errors = item.errors || [];
            item.errors.push({ error, at: new Date().toISOString() });
            item.status = item.retries >= CONFIG.MAX_RETRIES ? 'failed' : 'retrying';
            item.lastError = error;
            this.save();
        }
    }

    stats() {
        const s = { pending: 0, downloading: 0, retrying: 0, completed: 0, failed: 0 };
        for (const i of this.items) s[i.status] = (s[i.status] || 0) + 1;
        return s;
    }

    clear() {
        this.items = [];
        this.save();
    }

    clearCompleted() {
        this.items = this.items.filter(i => i.status !== 'completed');
        this.save();
    }
}

// ============================================================================
// SCANNER CLASS
// ============================================================================

class Scanner {
    constructor(queue) {
        this.queue = queue;
    }

    async scanDirectory(dir, type = 'movie') {
        if (!fs.existsSync(dir)) return { deleted: 0, requeued: 0 };

        log(`🔍 Scanning: ${dir}`, c.cyan);
        let deleted = 0, requeued = 0;

        const items = fs.readdirSync(dir);
        for (const item of items) {
            if (item.startsWith('.')) continue;
            const fullPath = path.join(dir, item);

            try {
                const stats = fs.statSync(fullPath);

                if (stats.isDirectory()) {
                    if (type === 'tv') {
                        const sub = await this.scanDirectory(fullPath, 'tv');
                        deleted += sub.deleted;
                        requeued += sub.requeued;
                    }
                    continue;
                }

                if (shouldIgnoreFile(item)) continue;

                const isTemp = item.endsWith('.temp.mp4') || item.endsWith('.temp.mkv') || item.endsWith('.part');
                const isEmpty = stats.size === 0;

                if (isEmpty || isTemp) {
                    log(`   🗑️ Deleting: ${item}`, c.gray);
                    fs.unlinkSync(fullPath);
                    deleted++;
                }
            } catch (e) { /* ignore */ }
        }

        return { deleted, requeued };
    }

    buildInventory() {
        log(`\n📦 Building Media Inventory...`, c.bold + c.cyan);
        const inventory = { movies: [], tvShows: [], scannedAt: new Date().toISOString() };

        const roots = [
            { path: CONFIG.MOVIE_DIR, type: 'movie' },
            { path: CONFIG.TV_DIR, type: 'tv' },
            { path: './downloads', type: 'movie' },
            { path: './downloads', type: 'tv' }
        ];

        for (const root of roots) {
            if (!fs.existsSync(root.path)) continue;
            log(`   Scanning: ${root.path}`, c.gray);

            if (root.type === 'movie') {
                this.scanMovieDir(root.path, inventory.movies);
            } else {
                this.scanTVDir(root.path, inventory.tvShows);
            }
        }

        const invPath = path.join(__dirname, 'inventory.json');
        fs.writeFileSync(invPath, JSON.stringify(inventory, null, 2));

        log(`\n📊 Inventory: ${inventory.movies.length} movies, ${inventory.tvShows.length} TV shows`, c.green);
        return inventory;
    }

    scanMovieDir(dir, movies) {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            // Skip hidden and Apple Double files
            if (item.startsWith('.') || item.startsWith('._')) continue;
            const fullPath = path.join(dir, item);
            try {
                const stats = fs.statSync(fullPath);
                if (stats.isFile() && (item.endsWith('.mkv') || item.endsWith('.mp4'))) {
                    movies.push({
                        title: item.replace(/\.(mkv|mp4)$/, ''),
                        path: fullPath,
                        sizeMB: Math.round(stats.size / 1024 / 1024)
                    });
                } else if (stats.isDirectory()) {
                    const subItems = fs.readdirSync(fullPath);
                    for (const sub of subItems) {
                        // Skip hidden and Apple Double files
                        if (sub.startsWith('.') || sub.startsWith('._')) continue;
                        if (sub.endsWith('.mkv') || sub.endsWith('.mp4')) {
                            const subPath = path.join(fullPath, sub);
                            const subStats = fs.statSync(subPath);
                            movies.push({
                                title: sub.replace(/\.(mkv|mp4)$/, ''),
                                path: subPath,
                                sizeMB: Math.round(subStats.size / 1024 / 1024)
                            });
                        }
                    }
                }
            } catch (e) { /* ignore */ }
        }
    }

    scanTVDir(dir, tvShows) {
        const shows = fs.readdirSync(dir);
        for (const showName of shows) {
            if (showName.startsWith('.') || showName.startsWith('._')) continue;
            const showPath = path.join(dir, showName);
            try {
                if (!fs.statSync(showPath).isDirectory()) continue;
                let episodeCount = 0;
                const seasons = fs.readdirSync(showPath);
                for (const season of seasons) {
                    const seasonPath = path.join(showPath, season);
                    if (!fs.statSync(seasonPath).isDirectory()) continue;
                    const episodes = fs.readdirSync(seasonPath);
                    for (const ep of episodes) {
                        if (ep.startsWith('._')) continue;
                        if (ep.endsWith('.mkv') || ep.endsWith('.mp4')) episodeCount++;
                    }
                }
                if (episodeCount > 0) {
                    tvShows.push({ name: showName, path: showPath, episodes: episodeCount, location: dir });
                }
            } catch (e) { /* ignore */ }
        }
    }

    findDuplicates(inventory) {
        log(`\n🔍 Checking for Duplicates...`, c.bold + c.cyan);
        const movieMap = new Map();
        for (const m of inventory.movies) {
            // Skip Apple Double entries
            if (m.title.startsWith('._')) continue;
            const key = m.title.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (!movieMap.has(key)) movieMap.set(key, []);
            movieMap.get(key).push(m);
        }

        let dupeCount = 0;
        for (const [key, items] of movieMap) {
            if (items.length > 1) {
                dupeCount++;
                log(`   🎬 ${items[0].title}:`, c.yellow);
                for (const copy of items) {
                    log(`      - ${copy.path} (${copy.sizeMB} MB)`, c.gray);
                }
            }
        }
        if (dupeCount === 0) log(`   ✅ No duplicates found.`, c.green);
        return dupeCount;
    }

    // Automatically detect existing TV shows on disk and add them to blacklist
    autoBlacklist() {
        log(`\n🛡️  Auto-Blacklisting existing shows...`, c.bold + c.cyan);
        const ignoreList = new Set(CONFIG.SKIP_SHOWS.map(s => s.toLowerCase()));
        let addedCount = 0;

        // NUCLEAR OPTION: Hardcoded Blacklist of EVERYTHING found on disk + Aliases
        // This list combines directory names found on user's disks with queue variations
        const HARDCODED_BLACKLIST = [
            // FROM ./downloads
            "alloallo", "allo allo", "halohalo",
            "blackadder", "black adder", "cernazmije", "cerna zmije",
            "blackbooks", "black books",
            "breakingbad", "breaking bad",
            "ceskasoda", "ceska soda",
            "comeback",
            "cowboybebop", "cowboy bebop",
            "dva_a_pul_chlapa", "dvaapulchlapa", "twoandahalfmen", "two and a half men",
            "familyguy", "family guy", "griffinovi",
            "gynekologie_2", "gynekologie",
            "hospoda",
            "house", "housemd",
            "howimetyourmother", "how i met your mother", "himym",
            "jmenujuseearl", "jmenuju se earl", "mynameisearl",
            "littlebritainabroad", "little britain abroad",
            "malavelkabritanie", "mala_velka_britanie", "mala velka britanie", "littlebritain", "little britain", "malavelkabritanieusa", "mala_velka_britanie_usa",
            "mrbean", "mr. bean", "mr bean",
            "okresniprebor", "okresni prebor",
            "reddwarf", "red dwarf", "cervenytrpaslik", "cerveny trpaslik",
            "rickandmorty", "rick and morty", "rickamorty",
            "siliconvalley", "silicon valley",
            "southpark", "south park",
            "thebigbangtheory", "the big bang theory", "bigbangtheory", "tbbt", "bbt", "teorievelkehotresku",
            "theitcrowd", "the it crowd", "itcrowd", "partickait",
            "youngsheldon", "young sheldon", "malysheldon",
            "brickleberry",
            "futurama",

            // FROM ./downloads
            "arcane",
            "attackontitan", "attack on titan",
            "bigmouth", "big mouth",
            "brooklynninenine", "brooklyn nine-nine", "brooklyn99",
            "onepunchman", "one punch man",
            "thementalist", "the mentalist",
            "theofficeus", "the office us", "theoffice", "the office"
            // NOTE: Weeds and NGE are NOT blacklisted - still downloading!
        ];

        // 1. Load Hardcoded List
        for (const show of HARDCODED_BLACKLIST) {
            const lower = show.toLowerCase();
            if (!ignoreList.has(lower)) {
                CONFIG.SKIP_SHOWS.push(show);
                ignoreList.add(lower);
                addedCount++;
            }
        }
        log(`   🚫 Loaded ${addedCount} hardcoded blacklist entries.`, c.gray);

        // 2. Still Scan Disks (just in case new things appear)
        for (const root of CONFIG.ALTERNATE_ROOTS) {
            if (!fs.existsSync(root)) continue;

            const isTvDir = root.toLowerCase().endsWith('tvshows') || root.toLowerCase().endsWith('tv shows');
            if (!isTvDir) continue;

            try {
                const shows = fs.readdirSync(root).filter(f => {
                    return !f.startsWith('.') && fs.statSync(path.join(root, f)).isDirectory();
                });

                for (const show of shows) {
                    const lowerShow = show.toLowerCase();
                    if (ignoreList.has(lowerShow)) continue;

                    // Check if show actually has content!
                    const showPath = path.join(root, show);
                    let hasContent = false;
                    try {
                        const seasons = fs.readdirSync(showPath);
                        for (const s of seasons) {
                            const sPath = path.join(showPath, s);
                            if (fs.statSync(sPath).isDirectory()) {
                                const eps = fs.readdirSync(sPath);
                                if (eps.some(e => e.endsWith('.mkv') || e.endsWith('.mp4'))) {
                                    hasContent = true;
                                    break;
                                }
                            } else if (s.endsWith('.mkv') || s.endsWith('.mp4')) {
                                hasContent = true;
                                break;
                            }
                        }
                    } catch (e) { }

                    if (hasContent) {
                        CONFIG.SKIP_SHOWS.push(show);
                        ignoreList.add(lowerShow);
                        log(`   🚫 Blacklisted: ${show} (Found on disk)`, c.gray);
                        addedCount++;
                    } else {
                        // log(`   ✨ Allowed: ${show} (Folder exists but no videos)`, c.gray);
                    }
                }
            } catch (e) { /* ignore */ }
        }

        if (addedCount > 0) {
            log(`   ✅ Added ${addedCount} shows to blacklist.`, c.green);
        } else {
            log(`   ✅ No new shows to blacklist.`, c.gray);
        }
    }

    // Remove pending downloads for blacklisted shows
    purgeBlacklisted() {
        if (CONFIG.SKIP_SHOWS.length === 0) return;

        const before = this.queue.items.length;
        // Normalize blacklist using the GLOBAL normalizeName function (handles diacritics)
        const blacklist = new Set(CONFIG.SKIP_SHOWS.map(s => normalizeName(s)));

        // Filter out pending items matches
        this.queue.items = this.queue.items.filter(item => {
            if (item.status !== 'pending') return true;

            const normTitle = normalizeName(item.title);
            // Check if normalized title starts with any normalized blacklist entry
            for (const blocked of blacklist) {
                if (normTitle.startsWith(blocked)) return false;
            }
            return true;
        });

        const removed = before - this.queue.items.length;
        if (removed > 0) {
            this.queue.save();
            log(`   🗑️  Purged ${removed} pending items for blacklisted shows.`, c.yellow);
        }
    }
}

// ============================================================================
// DOWNLOADER ENGINE
// ============================================================================

class Downloader {
    constructor(queue) {
        this.queue = queue;
        this.active = 0;
        this.sessionStats = {
            started: Date.now(),
            downloaded: 0,
            failed: 0,
            skipped: 0,
            totalBytes: 0
        };
        this.lastStatsLog = 0;
        this.lastStats = null;
        this.existsCache = null;  // Will be populated on first run
    }

    // Recursive scanner helper
    _scanDir(dir, cache, showContext = null) {
        try {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                if (item.startsWith('.') || item.startsWith('._')) continue;

                const fullPath = path.join(dir, item);
                try {
                    const stats = fs.statSync(fullPath);
                    if (stats.isDirectory()) {
                        // If checking a root folder (like "tvshows"), the next level is likely the Show Name
                        // If we are already in a Show Name, passed context remains
                        let nextContext = showContext;

                        // Heuristic: If we are scanning a root, this folder IS the show name
                        // We check if 'dir' is one of the roots
                        if (CONFIG.ALTERNATE_ROOTS.includes(dir) || dir.endsWith('tvshows') || dir.endsWith('TV Shows')) {
                            nextContext = item; // "Comeback"
                        }

                        this._scanDir(fullPath, cache, nextContext);
                    } else if (stats.isFile()) {
                        if (item.endsWith('.mkv') || item.endsWith('.mp4') || item.endsWith('.avi')) {
                            if (stats.size > CONFIG.MIN_SIZE_BYTES) {
                                const itemBase = item.replace(/\.(mkv|mp4|avi)$/, '');
                                const normBase = normalizeName(itemBase);
                                cache.add(normBase);

                                // SPECIAL HANDLING: S01E01.mp4 style files
                                // If the file is just SxxExx, we MUST prefix the show name for it to match anything
                                if (showContext && normBase.length < 15 && normBase.match(/s\d+e\d+/)) {
                                    const synthetic = normalizeName(`${showContext} ${itemBase}`);
                                    cache.add(synthetic);
                                    // log(`      + Synthetic: ${synthetic} (from ${itemBase})`, c.gray);
                                }
                            }
                        }
                    }
                } catch (e) { /* ignore access errors */ }
            }
        } catch (e) { /* ignore dir errors */ }
    }

    // Build a cache of all existing movies/episodes for fast O(1) lookups
    buildExistsCache() {
        const cache = new Set();
        log(`   🔎 Building file inventory...`, c.gray);

        for (const root of CONFIG.ALTERNATE_ROOTS) {
            if (!fs.existsSync(root)) continue;
            this._scanDir(root, cache);
        }

        log(`   ✅ Inventory cached: ${cache.size} items known.`, c.gray);
        return cache;
    }

    async processQueue() {
        log(`\n🚀 Starting Download Engine (Parallel: ${CONFIG.PARALLEL_LIMIT})`, c.bold + c.cyan);

        // Build exists cache for fast lookups
        log(`📂 Building movie index...`, c.gray);
        this.existsCache = this.buildExistsCache();
        log(`   Indexed ${this.existsCache.size} existing movies`, c.gray);

        // Check disk space first
        const freeSpace = await checkDiskSpace(CONFIG.MOVIE_DIR);
        log(`💾 Disk space: ${freeSpace} GB free`, freeSpace < CONFIG.MIN_DISK_SPACE_GB ? c.red : c.green);
        if (freeSpace < CONFIG.MIN_DISK_SPACE_GB) {
            log(`⚠️ Low disk space! Need at least ${CONFIG.MIN_DISK_SPACE_GB} GB. Aborting.`, c.red);
            return;
        }

        while (!isShuttingDown) {
            const stats = this.queue.stats();

            // Only log stats if changed or every STATS_THROTTLE_MS
            const statsJson = JSON.stringify(stats);
            const now = Date.now();
            if (statsJson !== this.lastStats || now - this.lastStatsLog > CONFIG.STATS_THROTTLE_MS) {
                log(`📊 Queue: ${stats.pending} pending, ${stats.retrying} retrying, ${stats.completed} done, ${stats.failed} failed`, c.gray);
                this.lastStats = statsJson;
                this.lastStatsLog = now;
            }

            const pending = this.queue.getPending(CONFIG.PARALLEL_LIMIT - this.active);
            const retrying = this.queue.getRetrying().slice(0, CONFIG.PARALLEL_LIMIT - this.active - pending.length);
            const toProcess = [...pending, ...retrying];

            if (toProcess.length === 0 && this.active === 0) {
                if (stats.pending === 0 && stats.retrying === 0) {
                    this.printFinalSummary();
                    break;
                }
                await sleep(2000);
                continue;
            }

            for (const item of toProcess) {
                this.downloadItem(item);
            }

            await sleep(5000);
        }
    }

    printFinalSummary() {
        const elapsed = Date.now() - this.sessionStats.started;
        const stats = this.queue.stats();

        log(`\n${'═'.repeat(60)}`, c.green);
        log(`✨ DOWNLOAD SESSION COMPLETE`, c.bold + c.green);
        log(`${'═'.repeat(60)}`, c.green);
        log(`   ⏱️  Duration:    ${formatDuration(elapsed)}`, c.cyan);
        log(`   ✅ Downloaded:  ${this.sessionStats.downloaded} (${formatSize(this.sessionStats.totalBytes)})`, c.green);
        log(`   ⏭️  Skipped:     ${this.sessionStats.skipped}`, c.yellow);
        log(`   ❌ Failed:      ${this.sessionStats.failed}`, c.red);
        log(`   📊 Queue total: ${stats.completed} completed, ${stats.failed} failed`, c.gray);
        log(`${'═'.repeat(60)}`, c.green);
    }

    async downloadItem(item) {
        this.active++;
        activeDownloads.set(item.id, item);
        this.queue.update(item.id, { status: 'downloading', lastAttempt: new Date().toISOString() });

        const startTime = Date.now();
        log(`\n⬇️  [${item.type.toUpperCase()}] ${item.title}`, c.cyan);

        const MAX_IMMEDIATE_RETRIES = 3;
        let lastError = null;

        for (let attempt = 1; attempt <= MAX_IMMEDIATE_RETRIES; attempt++) {
            if (isShuttingDown) break;

            try {
                if (this.checkExists(item.outputPath)) {
                    log(`   ⏭️  Already exists, skipping.`, c.yellow);
                    this.queue.markComplete(item.id, 0);
                    this.sessionStats.skipped++;
                    this.active--;
                    activeDownloads.delete(item.id);
                    return;
                }

                // Ensure output directory exists
                const dir = path.dirname(item.outputPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                let result;
                if (item.url && item.url.includes('nahnoji')) {
                    result = await downloadFromNahnoji(item.url, item.outputPath);
                } else {
                    result = await downloadFromPrehrajto(item.url, item.outputPath);
                }

                // Verify
                if (fs.existsSync(item.outputPath)) {
                    const size = fs.statSync(item.outputPath).size;
                    if (size > CONFIG.MIN_SIZE_BYTES) {
                        // CHECK TRANSCODE
                        await this.checkAndTranscode(item, size);
                        const finalSize = fs.statSync(item.outputPath).size; // Refresh size

                        const elapsed = Date.now() - startTime;
                        const speed = finalSize / (elapsed / 1000);
                        log(`   ✅ Done: ${formatSize(finalSize)} in ${formatDuration(elapsed)} (${formatSpeed(speed)})`, c.green);
                        this.queue.markComplete(item.id, finalSize);
                        this.sessionStats.downloaded++;
                        this.sessionStats.totalBytes += finalSize;
                        this.active--;
                        activeDownloads.delete(item.id);
                        return;
                    }
                }

                lastError = result?.error || 'Verification failed - file too small';
                if (attempt < MAX_IMMEDIATE_RETRIES) {
                    log(`   🔄 Retry ${attempt}/${MAX_IMMEDIATE_RETRIES}...`, c.yellow);
                    await sleep(3000);
                }

            } catch (e) {
                lastError = e.message;
                if (attempt < MAX_IMMEDIATE_RETRIES) {
                    log(`   🔄 Retry ${attempt}/${MAX_IMMEDIATE_RETRIES}: ${e.message}`, c.yellow);
                    await sleep(3000);
                }
            }
        }

        log(`   ❌ Failed: ${lastError}`, c.red);

        // Auto-refetch logic: Try to find a replacement URL if we haven't already
        if (!item.refetched) {
            log(`   🔄 Attempting to find replacement URL for: ${item.title}`, c.yellow);
            try {
                const results = await searchPrehrajto(item.title);
                if (results.length > 0) {
                    // Determine quality profile (default to medium)
                    const profileName = item.quality || 'medium';
                    const profile = CONFIG.QUALITY_PROFILES[profileName] || CONFIG.QUALITY_PROFILES.medium;
                    log(`   🎯 Targeting quality: ${profileName} (${profile.target}MB)`, c.gray);

                    const TARGET_MIN_MB = profile.min;
                    const TARGET_MAX_MB = profile.max;
                    const IDEAL_MB = profile.target;

                    results.sort((a, b) => {
                        const aInRange = a.sizeMB >= TARGET_MIN_MB && a.sizeMB <= TARGET_MAX_MB;
                        const bInRange = b.sizeMB >= TARGET_MIN_MB && b.sizeMB <= TARGET_MAX_MB;
                        if (aInRange && !bInRange) return -1;
                        if (!aInRange && bInRange) return 1;
                        return Math.abs(a.sizeMB - IDEAL_MB) - Math.abs(b.sizeMB - IDEAL_MB);
                    });

                    const best = results[0];
                    log(`   ⭐ Found replacement: ${best.title} (${best.sizeFormatted})`, c.green);

                    // Update item with new URL and reset status
                    this.queue.update(item.id, {
                        url: best.url,
                        status: 'pending',
                        retries: 0,
                        errors: [...(item.errors || []), { error: lastError + ' (Auto-refetching)', at: new Date().toISOString() }],
                        lastError: null,
                        refetched: true, // Mark as refetched so we don't loop forever
                        addedAt: new Date().toISOString()
                    });

                    this.active--;
                    activeDownloads.delete(item.id);
                    return; // Exit without marking as failed
                } else {
                    log(`   ❌ No replacement found.`, c.red);
                }
            } catch (err) {
                log(`   ❌ Error finding replacement: ${err.message}`, c.red);
            }
        }

        this.queue.markFailed(item.id, lastError);
        this.sessionStats.failed++;
        this.active--;
        activeDownloads.delete(item.id);
    }

    // Check if showing needs transcoding
    async checkAndTranscode(item, size) {
        // CUSTOM TRANSCODE SETTINGS (from queue item) -----------------------------
        if (item.transcode && item.transcode.enabled) {
            const resolution = item.transcode.resolution || 720;
            const crf = item.transcode.crf || 23;
            log(`   ⚠️  Custom Transcode to ${resolution}p (Size: ${(size / 1024 / 1024).toFixed(2)} MB)...`, c.yellow);
            await this.transcodeToResolution(item.outputPath, resolution, crf);
            return;
        }

        // AUTO-TRANSCODE LOGIC ----------------------------------------------------
        // Check if show needs transcoding to SD (e.g. Weeds, Old Sitcoms)
        const AUTO_TRANSCODE_SHOWS = ['weeds', 'tráva', 'trava', 'itcrowd', 'partickait', 'blackbooks'];
        const showNameMatch = item.title.match(/^(.+?) s\d+e\d+/i);
        const showName = showNameMatch ? showNameMatch[1].toLowerCase().replace(/[^a-z0-9]/g, '') : '';

        const isAutoTranscodeShow = AUTO_TRANSCODE_SHOWS.some(s => showName.includes(s));

        // Exception: Skip Season 07 explicitly (User Request)
        if (item.outputPath.includes("Season 07") || item.title.includes("S07")) {
            return;
        }

        if (isAutoTranscodeShow) {
            const SIZE_THRESHOLD = 300 * 1024 * 1024; // 300 MB
            if (size > SIZE_THRESHOLD) {
                log(`   ⚠️  Auto-Transcoding to SD (Size: ${(size / 1024 / 1024).toFixed(2)} MB)...`, c.yellow);
                await this.transcodeToSD(item.outputPath);
            }
        }
        // --------------------------------------------------------------------------
    }

    async transcodeToSD(inputPath) {
        const tempOutput = inputPath.replace('.mkv', '.sd.mkv');

        // FFmpeg: scale height to 480p, VideoToolBox hardware encoder (ARM Mac)
        // Using q:v 55 for good quality (0 = best, 100 = worst)
        const cmd = `ffmpeg -y -v error -i "${inputPath}" \
            -vf "scale=-2:480" \
            -c:v h264_videotoolbox -q:v 55 \
            -c:a copy \
            "${tempOutput}"`;

        try {
            await execAsync(cmd);

            if (fs.existsSync(tempOutput) && fs.statSync(tempOutput).size > 1000) {
                const oldSize = fs.statSync(inputPath).size;
                const newSize = fs.statSync(tempOutput).size;

                // Replace original
                fs.unlinkSync(inputPath);
                fs.renameSync(tempOutput, inputPath);

                const reduction = Math.round((1 - (newSize / oldSize)) * 100);
                log(`   📉 Transcoded: ${(oldSize / 1024 / 1024).toFixed(0)}MB -> ${(newSize / 1024 / 1024).toFixed(0)}MB (Saved ${reduction}%)`, c.green);
            }
        } catch (e) {
            log(`   ❌ Transcode failed: ${e.message}`, c.red);
            if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
        }
    }

    async transcodeToResolution(inputPath, resolution = 720, crf = 23) {
        const ext = path.extname(inputPath);
        const tempOutput = inputPath.replace(ext, `.${resolution}p${ext}`);

        // FFmpeg: scale height to specified resolution, VideoToolBox hardware encoder (ARM Mac)
        // Map CRF roughly to VTB quality: CRF 23 -> q:v 55, CRF 18 -> q:v 45, CRF 28 -> q:v 65
        const vtbQuality = Math.round(30 + (crf * 1.5)); // Rough mapping
        const cmd = `ffmpeg -y -v error -i "${inputPath}" \
            -vf "scale=-2:${resolution}" \
            -c:v h264_videotoolbox -q:v ${vtbQuality} \
            -c:a aac -b:a 128k \
            "${tempOutput}"`;

        try {
            await execAsync(cmd);

            if (fs.existsSync(tempOutput) && fs.statSync(tempOutput).size > 1000) {
                const oldSize = fs.statSync(inputPath).size;
                const newSize = fs.statSync(tempOutput).size;

                // Replace original
                fs.unlinkSync(inputPath);
                fs.renameSync(tempOutput, inputPath);

                const reduction = Math.round((1 - (newSize / oldSize)) * 100);
                log(`   📉 Transcoded to ${resolution}p: ${(oldSize / 1024 / 1024).toFixed(0)}MB -> ${(newSize / 1024 / 1024).toFixed(0)}MB (Saved ${reduction}%)`, c.green);
            }
        } catch (e) {
            log(`   ❌ Transcode to ${resolution}p failed: ${e.message}`, c.red);
            if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
        }
    }

    checkExists(outputPath) {
        // Direct path check (for exact matches)
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > CONFIG.MIN_SIZE_BYTES) return true;
        const mp4 = outputPath.replace('.mkv', '.mp4');
        if (fs.existsSync(mp4) && fs.statSync(mp4).size > CONFIG.MIN_SIZE_BYTES) return true;

        // Use cache for fast lookup (O(1) instead of O(n))
        if (this.existsCache) {
            const basename = path.basename(outputPath).replace(/\.(mkv|mp4|avi)$/, '');
            const normalizedName = normalizeName(basename);
            if (this.existsCache.has(normalizedName)) return true;

            // SMART MATCH: Try matching just the "Show Name SxxExx" part
            // Target: "Comeback - S02E17 - Strakonice" -> Match "Comeback S02E17"
            // This allows us to match against the synthetic keys generated by the scanner
            const shortMatch = basename.match(/^(.+? - S\d+E\d+)/);
            if (shortMatch) {
                const shortKey = normalizeName(shortMatch[1].replace(' - ', ' '));
                if (this.existsCache.has(shortKey)) {
                    // log(`   ✨ Smart match: ${basename} matched via ${shortKey}`, c.gray);
                    return true;
                }
            }
            return false;
        }

        return false;
    }
}

// ============================================================================
// MEDIA MANAGER - Main Orchestrator
// ============================================================================

class MediaManager {
    constructor() {
        this.queue = new Queue(CONFIG.QUEUE_FILE);
        this.scanner = new Scanner(this.queue);
        this.downloader = new Downloader(this.queue);
        setupShutdownHandler(this.queue);
    }

    async run(command, args = []) {
        log(`\n${'═'.repeat(60)}`, c.cyan);
        log(`🦾 SMART MEDIA MANAGER v2.1`, c.bold + c.cyan);
        log(`${'═'.repeat(60)}`, c.cyan);

        switch (command) {
            case 'run':
                await this.runFull();
                break;
            case 'scan':
                await this.runScan();
                break;
            case 'download':
                await this.downloader.processQueue();
                break;
            case 'inventory':
                this.scanner.buildInventory();
                break;
            case 'duplicates':
                const inv = this.scanner.buildInventory();
                this.scanner.findDuplicates(inv);
                break;
            case 'wanted':
                await this.loadWantedList();
                break;
            case 'add-movie':
                await this.addMovie(args[0]);
                break;
            case 'add-tv':
                await this.addTVShow(args[0]);
                break;
            case 'status':
                this.showStatus();
                break;
            case 'clear':
                this.queue.clear();
                log(`🗑️  Queue cleared.`, c.yellow);
                break;
            case 'clear-done':
                this.queue.clearCompleted();
                log(`🗑️  Completed items cleared.`, c.yellow);
                break;
            case 'remove':
                this.removeFromQueue(args[0]);
                break;
            case 'subs':
            case 'fetch-subs':
                await this.fetchSubtitles(args[0]);
                break;
            case 'titulky':
            case 'fetch-titulky':
                await this.fetchTitulky(args[0]);
                break;
            default:
                this.showHelp();
        }
    }

    async fetchTitulky(target) {
        if (!target) {
            log(`Usage: smart-media-manager titulky <file>`, c.red);
            return;
        }

        const fullPath = path.resolve(target);
        if (!fs.existsSync(fullPath)) {
            log(`❌ Path not found: ${fullPath}`, c.red);
            return;
        }

        if (fs.statSync(fullPath).isDirectory()) {
            log(`❌ Directory scan not supported for Titulky yet (use loop manually).`, c.red);
            return;
        }

        log(`\n🕸️  Running Titulky.com Scraper`, c.bold + c.cyan);
        await titulkyFetcher.fetchTitulky(path.basename(fullPath), path.dirname(fullPath));
    }

    async fetchSubtitles(target) {
        if (!target) {
            log(`Usage: smart-media-manager subs <file|directory>`, c.red);
            return;
        }

        const apiKey = CONFIG.OPENSUBTITLES_API_KEY;
        const fullPath = path.resolve(target);

        if (!fs.existsSync(fullPath)) {
            log(`❌ Path not found: ${fullPath}`, c.red);
            return;
        }

        log(`\n🎬 Subtitle Fetcher`, c.bold + c.cyan);
        log(`   Target: ${fullPath}`, c.gray);
        log(`   API Key: ${apiKey ? 'configured' : 'missing'}`, c.gray);

        try {
            const stats = fs.statSync(fullPath);
            if (stats.isDirectory()) {
                log(`   Scanning directory for media files...`, c.cyan);
                const results = await subtitleFetcher.fetchSubtitlesForDirectory(fullPath, { apiKey, verbose: true });
                log(`\n✅ Processed ${results.length} files.`, c.green);
            } else {
                log(`   Fetching subtitles for file...`, c.cyan);
                await subtitleFetcher.fetchSubtitlesForFile(fullPath, { apiKey, verbose: true });
                log(`\n✅ Done.`, c.green);
            }
        } catch (e) {
            log(`❌ Error fetching subtitles: ${e.message}`, c.red);
        }
    }

    async retryFailed() {
        const failedItems = this.queue.items.filter(i => i.status === 'failed');
        if (failedItems.length === 0) {
            log(`✅ No failed items to retry.`, c.green);
            return;
        }

        log(`🔄 Retrying ${failedItems.length} failed items...`, c.cyan);

        for (const item of failedItems) {
            log(`\n🔍 Finding new replacement for: ${item.title}`, c.yellow);

            // Search for new URL
            const results = await searchPrehrajto(item.title);
            if (results.length > 0) {
                // Prefer files in 1-5 GB range
                const TARGET_MIN_MB = 1000;
                const TARGET_MAX_MB = 5000;
                const IDEAL_MB = 2000;

                results.sort((a, b) => {
                    const aInRange = a.sizeMB >= TARGET_MIN_MB && a.sizeMB <= TARGET_MAX_MB;
                    const bInRange = b.sizeMB >= TARGET_MIN_MB && b.sizeMB <= TARGET_MAX_MB;
                    if (aInRange && !bInRange) return -1;
                    if (!aInRange && bInRange) return 1;
                    return Math.abs(a.sizeMB - IDEAL_MB) - Math.abs(b.sizeMB - IDEAL_MB);
                });

                const best = results[0];
                log(`   ⭐ Found replacement: ${best.title} (${best.sizeFormatted})`, c.green);

                // Update item with new URL and reset status
                this.queue.update(item.id, {
                    url: best.url,
                    status: 'pending',
                    retries: 0,
                    errors: [],
                    lastError: null,
                    addedAt: new Date().toISOString() // Bump timestamp
                });
                log(`   ✅ URL updated and requeued.`, c.green);
            } else {
                log(`   ❌ No replacement found. Leaving as failed.`, c.red);
            }

            // Random delay to avoid rate limiting
            await sleep(2000 + Math.random() * 2000);
        }
    }

    removeFromQueue(query) {
        if (!query) {
            log(`Usage: smart-media-manager remove "Movie Title"`, c.red);
            return;
        }
        const queryLower = query.toLowerCase();
        const toRemove = this.queue.items.filter(i =>
            i.title.toLowerCase().includes(queryLower) &&
            (i.status === 'pending' || i.status === 'retrying')
        );

        if (toRemove.length === 0) {
            log(`❌ No pending/retrying items matching "${query}"`, c.yellow);
            return;
        }

        for (const item of toRemove) {
            log(`🗑️  Removing: ${item.title}`, c.yellow);
            this.queue.items = this.queue.items.filter(i => i.id !== item.id);
        }
        this.queue.save();
        log(`   ✅ Removed ${toRemove.length} items.`, c.green);
    }

    async runFull() {
        log(`\n🚀 FULL COMPREHENSIVE RUN`, c.bold + c.magenta);

        log(`\n📦 Step 1/6: Building Inventory...`, c.cyan);
        const inventory = this.scanner.buildInventory();

        // RECONCILIATION STEP: Verify "Completed" items actually exist
        log(`\n🧐 Step 1.5/6: Verifying Completed Items...`, c.cyan);
        const existsCache = this.downloader.buildExistsCache(); // Ensure fresh cache
        let recovered = 0;

        this.queue.items.forEach(item => {
            if (item.status === 'completed') {
                if (!this.downloader.checkExists(item.outputPath)) {
                    // Double check with cache manually if checkExists fails (it uses cache internally anyway)
                    // If checkExists says false, it means it's NOT on disk and NOT in cache.
                    log(`   ⚠️  Item marked completed but missing: ${item.title}`, c.yellow);
                    item.status = 'pending';
                    item.retries = 0;
                    delete item.errors;
                    recovered++;
                }
            }
        });
        if (recovered > 0) {
            log(`   ✅ Recovered ${recovered} items to pending queue.`, c.green);
            this.queue.save();
        } else {
            log(`   ✅ All completed items verified.`, c.gray);
        }

        log(`\n🔍 Step 2/6: Checking Duplicates...`, c.cyan);
        this.scanner.findDuplicates(inventory);

        log(`\n🧹 Step 3/6: Scanning & Cleaning...`, c.cyan);
        await this.runScan();

        log(`\n📋 Step 4/6: Loading Wanted List...`, c.cyan);
        await this.loadWantedList();

        log(`\n🛡️  Step 4.5/6: Enforcing Blacklist...`, c.cyan);
        this.scanner.autoBlacklist();
        this.scanner.purgeBlacklisted();


        log(`\n⬇️  Step 5/6: Processing Downloads...`, c.cyan);
        await this.downloader.processQueue();
        log(`\n🎬 Step 6/6: Fetching Subtitles...`, c.cyan);
        try {
            const subStatus = await getSubtitleStatus();
            log(`   📊 Subtitle Status: ${subStatus.complete} complete, ${subStatus.partial} partial, ${subStatus.missing} missing`, c.gray);
            if (subStatus.missing > 0 || subStatus.partial > 0) {
                log(`   ⬇️  Fetching missing subtitles (EN + CS)...`, c.cyan);
                await fetchSubtitles({ limit: 20 }); // Limit to 20 per run to respect API quota
            } else {
                log(`   ✅ All videos have subtitles!`, c.green);
            }
        } catch (e) {
            log(`   ⚠️  Subtitle fetch error: ${e.message}`, c.yellow);
        }

        log(`\n${'═'.repeat(60)}`, c.green);
        log(`🎉 FULL RUN COMPLETE!`, c.bold + c.green);
    }

    async runScan() {
        log(`\n📡 Running Library Scan...`, c.bold);
        const movieResult = await this.scanner.scanDirectory(CONFIG.MOVIE_DIR, 'movie');
        log(`   Movies: Deleted ${movieResult.deleted}`, c.gray);
        const tvResult = await this.scanner.scanDirectory(CONFIG.TV_DIR, 'tv');
        log(`   TV: Deleted ${tvResult.deleted}`, c.gray);
    }

    async loadWantedList() {
        if (!fs.existsSync(CONFIG.WANTED_FILE)) {
            log(`⚠️  Wanted file not found: ${CONFIG.WANTED_FILE}`, c.yellow);
            return;
        }

        const data = JSON.parse(fs.readFileSync(CONFIG.WANTED_FILE, 'utf-8'));
        let added = 0;

        for (const movie of data.movies || []) {
            const title = `${movie.title} (${movie.year})`;
            const outputPath = path.join(CONFIG.MOVIE_DIR, `${title}.mkv`);

            if (this.downloader.checkExists(outputPath)) continue;
            if (!movie.links || movie.links.length === 0) continue;

            const wasAdded = this.queue.add({
                type: 'movie',
                title: title,
                url: movie.links[0],
                source: 'prehrajto.cz',
                outputPath: outputPath
            });
            if (wasAdded) added++;
        }

        log(`   ✅ Added ${added} movies from wanted list.`, c.green);
    }

    async addMovie(title) {
        if (!title) {
            log(`Usage: smart-media-manager add-movie "Title (Year)"`, c.red);
            return;
        }
        log(`🔍 Searching: ${title}`, c.cyan);
        const results = await searchPrehrajto(title);
        if (results.length > 0) {
            // Prefer files in 1-5 GB range (good 1080p quality without being excessive)
            // Score: files in target range get priority, then closest to 2GB ideal
            const TARGET_MIN_MB = 1000;  // 1 GB
            const TARGET_MAX_MB = 5000;  // 5 GB
            const IDEAL_MB = 2000;       // 2 GB

            results.sort((a, b) => {
                const aInRange = a.sizeMB >= TARGET_MIN_MB && a.sizeMB <= TARGET_MAX_MB;
                const bInRange = b.sizeMB >= TARGET_MIN_MB && b.sizeMB <= TARGET_MAX_MB;

                // Prefer files in target range
                if (aInRange && !bInRange) return -1;
                if (!aInRange && bInRange) return 1;

                // If both in range (or both out), prefer closer to ideal
                return Math.abs(a.sizeMB - IDEAL_MB) - Math.abs(b.sizeMB - IDEAL_MB);
            });

            const best = results[0];
            log(`   ⭐ Found: ${best.title} (${best.sizeFormatted})`, c.green);
            this.queue.add({
                type: 'movie',
                title: title,
                url: best.url,
                source: 'prehrajto.cz',
                outputPath: path.join(CONFIG.MOVIE_DIR, `${title}.mkv`)
            });
            log(`   ✅ Added to queue.`, c.green);
        } else {
            log(`   ❌ No results.`, c.red);
        }
    }

    async addTVShow(showFile) {
        if (!showFile) {
            log(`Usage: smart-media-manager add-tv <showfile.json | all>`, c.red);
            return;
        }

        let showsToProcess = [];
        if (showFile === 'all') {
            showsToProcess = loadAllTVShows();
        } else {
            const shows = loadAllTVShows();
            const show = shows.find(s =>
                s.filename === showFile ||
                s.filename === `${showFile}.json` ||
                s.showName.toLowerCase() === showFile.toLowerCase()
            );
            if (show) showsToProcess = [show];
        }

        if (showsToProcess.length === 0) {
            log(`❌ Show not found: ${showFile}`, c.red);
            return;
        }

        log(`📺 Processing ${showsToProcess.length} shows...`, c.cyan);
        let totalAdded = 0;

        for (const show of showsToProcess) {
            if (CONFIG.SKIP_SHOWS.some(s => s.toLowerCase() === show.showName.toLowerCase())) {
                log(`   ⏭️  Skipping avoided show: ${show.showName}`, c.yellow);
                continue;
            }

            log(`   Scanning: ${show.showName}`, c.gray);
            for (const season of show.seasons || []) {
                for (const ep of season.episodes || []) {
                    if (ep.status === 'downloaded') continue;

                    const outputPath = getJellyfinPath(show.showName, season.season, ep.episode, ep.title);
                    const title = `${show.showName} S${String(season.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;

                    const added = this.queue.add({
                        type: 'tv',
                        title: title,
                        url: ep.url,
                        source: 'nahnoji.cz',
                        outputPath: outputPath,
                        quality: show.quality || 'medium' // Persist quality preference
                    });
                    if (added) totalAdded++;
                }
            }
        }
        log(`   ✅ Queued ${totalAdded} new episodes.`, c.green);
    }

    showStatus() {
        const stats = this.queue.stats();
        log(`\n📊 Queue Status:`, c.bold);
        log(`   Pending:     ${stats.pending}`, c.yellow);
        log(`   Downloading: ${stats.downloading}`, c.cyan);
        log(`   Retrying:    ${stats.retrying}`, c.yellow);
        log(`   Completed:   ${stats.completed}`, c.green);
        log(`   Failed:      ${stats.failed}`, c.red);
        log(`   Total:       ${this.queue.items.length}`);

        // Show failed items with errors
        const failed = this.queue.items.filter(i => i.status === 'failed');
        if (failed.length > 0) {
            log(`\n❌ Failed Items:`, c.bold + c.red);
            for (const item of failed.slice(0, 10)) {
                log(`   • ${item.title}`, c.red);
                if (item.errors && item.errors.length > 0) {
                    const lastErr = item.errors[item.errors.length - 1];
                    log(`     └─ ${lastErr.error}`, c.gray);
                }
            }
            if (failed.length > 10) {
                log(`   ... and ${failed.length - 10} more`, c.gray);
            }
        }

        // Show retrying items
        const retrying = this.queue.items.filter(i => i.status === 'retrying');
        if (retrying.length > 0) {
            log(`\n🔄 Retrying Items:`, c.bold + c.yellow);
            for (const item of retrying.slice(0, 5)) {
                log(`   • ${item.title} (attempt ${item.retries}/${CONFIG.MAX_RETRIES})`, c.yellow);
            }
        }
    }

    showHelp() {
        log(`
Usage: node smart-media-manager.js <command> [args]

Commands:
  run           🚀 Full comprehensive run (inventory + scan + wanted + download)
  scan          Scan library for broken/temp files
  download      Process download queue
  inventory     Build media inventory
  duplicates    Find duplicate files
  wanted        Load movies from wanted_movies.json
  add-movie     Add movie: add-movie "Title (Year)"
  add-tv        Add TV show: add-tv <show.json | all>
  status        Show queue status with error details
  clear         Clear entire download queue
  clear-done    Clear only completed items from queue

Log file: ${CONFIG.LOG_FILE}
        `, c.gray);
    }
}

// ============================================================================
// TV SHOW HELPERS
// ============================================================================

function loadAllTVShows() {
    if (!fs.existsSync(CONFIG.SHOWS_DIR)) return [];
    try {
        const files = fs.readdirSync(CONFIG.SHOWS_DIR).filter(f => f.endsWith('.json'));
        return files.map(f => {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(CONFIG.SHOWS_DIR, f), 'utf-8'));
                data.filename = f;
                return data;
            } catch (e) { return null; }
        }).filter(s => s && s.showName);
    } catch (e) { return []; }
}

function getJellyfinPath(showName, season, episode, title) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    const safeTitle = title.replace(/[/\\?%*:|"<>]/g, '').trim();
    const seasonFolder = path.join(CONFIG.TV_DIR, showName, `Season ${s}`);
    const fileName = `${showName} - S${s}E${e} - ${safeTitle}.mkv`;
    return path.join(seasonFolder, fileName);
}

// ============================================================================
// MAIN
// ============================================================================

const manager = new MediaManager();
const [, , command, ...args] = process.argv;
manager.run(command || 'status', args);
