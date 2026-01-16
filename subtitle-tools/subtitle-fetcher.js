/**
 * Subtitle Fetcher Module
 * 
 * Downloads subtitles from OpenSubtitles.com for movies and TV shows.
 * Supports file hash matching for accurate results.
 * 
 * Languages: English (en), Czech (cs)
 */

import { existsSync, createReadStream, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import https from 'https';
import zlib from 'zlib';

// OpenSubtitles.com API configuration
const API_BASE = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'SubtitleFetcher v1.0';

// ANSI colors
const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m'
};

/**
 * Calculate OpenSubtitles file hash
 * The hash is based on file size and first/last 64KB of the file
 */
async function calculateHash(filePath) {
    return new Promise((resolve, reject) => {
        const CHUNK_SIZE = 65536; // 64KB

        try {
            const stats = statSync(filePath);
            const fileSize = stats.size;

            if (fileSize < CHUNK_SIZE * 2) {
                return reject(new Error('File too small for hash calculation'));
            }

            // Read first and last 64KB
            const buffer = Buffer.alloc(CHUNK_SIZE * 2);
            const fd = openSync(filePath, 'r');

            // Read first chunk
            readSync(fd, buffer, 0, CHUNK_SIZE, 0);
            // Read last chunk
            readSync(fd, buffer, CHUNK_SIZE, CHUNK_SIZE, fileSize - CHUNK_SIZE);
            closeSync(fd);

            // Calculate hash (sum of bytes + file size)
            let hash = BigInt(fileSize);
            for (let i = 0; i < buffer.length; i += 8) {
                hash += buffer.readBigUInt64LE(i);
                hash = hash & BigInt('0xFFFFFFFFFFFFFFFF'); // Keep it 64-bit
            }

            resolve(hash.toString(16).padStart(16, '0'));
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Extract movie info from filename
 */
function parseFilename(filename) {
    const basename = path.basename(filename, path.extname(filename));

    // Try to match "Title (Year)" pattern
    const match = basename.match(/^(.+?)\s*\((\d{4})\)/);
    if (match) {
        return {
            title: match[1].trim(),
            year: parseInt(match[2])
        };
    }

    // Try to extract title with common release patterns
    const cleanTitle = basename
        .replace(/\./g, ' ')
        .replace(/\[.*?\]/g, '')
        .replace(/\(.*?\)/g, '')
        .replace(/(720p|1080p|2160p|4k|bluray|bdrip|webrip|web-dl|hdtv|x264|x265|hevc|aac|dts)/gi, '')
        .trim();

    return { title: cleanTitle, year: null };
}

/**
 * Make API request with redirect support
 */
async function apiRequest(endpoint, options = {}, redirectCount = 0) {
    const { method = 'GET', body = null, apiKey, token } = options;
    const MAX_REDIRECTS = 5;

    return new Promise((resolve, reject) => {
        const url = new URL(endpoint, API_BASE);

        const reqOptions = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method,
            headers: {
                'User-Agent': USER_AGENT,
                'Content-Type': 'application/json',
                'Api-Key': apiKey || ''
            }
        };

        if (token) {
            reqOptions.headers['Authorization'] = `Bearer ${token}`;
        }

        const req = https.request(reqOptions, (res) => {
            // Handle redirects
            if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                if (redirectCount >= MAX_REDIRECTS) {
                    return reject(new Error('Too many redirects'));
                }
                // Handle relative redirects by prepending the base URL
                let redirectUrl = res.headers.location;
                if (redirectUrl.startsWith('/')) {
                    redirectUrl = `https://${url.hostname}${redirectUrl}`;
                }
                // Follow redirect
                return apiRequest(redirectUrl, options, redirectCount + 1)
                    .then(resolve)
                    .catch(reject);
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });

        req.on('error', reject);

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

/**
 * Search for subtitles on OpenSubtitles.com
 */
async function searchSubtitles(query, options = {}) {
    const { languages = ['en', 'cs'], apiKey, moviehash = null, imdbId = null } = options;

    const params = new URLSearchParams();

    if (moviehash) {
        params.append('moviehash', moviehash);
    }
    if (imdbId) {
        params.append('imdb_id', imdbId.replace('tt', ''));
    }
    if (query.title) {
        params.append('query', query.title);
    }
    if (query.year) {
        params.append('year', query.year);
    }

    params.append('languages', languages.join(','));
    params.append('order_by', 'download_count');
    params.append('order_direction', 'desc');

    // Build full URL with API_BASE
    const searchUrl = `${API_BASE}/subtitles?${params.toString()}`;

    const response = await apiRequest(searchUrl, { apiKey });

    if (response.status === 200 && response.data.data) {
        return response.data.data.map(sub => ({
            id: sub.id,
            fileId: sub.attributes.files?.[0]?.file_id,
            language: sub.attributes.language,
            downloads: sub.attributes.download_count,
            release: sub.attributes.release,
            fps: sub.attributes.fps,
            format: sub.attributes.format,
            url: sub.attributes.url
        }));
    }

    return [];
}

/**
 * Download subtitle file
 */
async function downloadSubtitle(fileId, outputPath, options = {}) {
    const { apiKey, token } = options;

    // First, get download link
    const response = await apiRequest('/download', {
        method: 'POST',
        body: { file_id: fileId },
        apiKey,
        token
    });

    if (response.status !== 200 || !response.data.link) {
        throw new Error(`Failed to get download link: ${JSON.stringify(response.data)}`);
    }

    const downloadUrl = response.data.link;

    // Download the file
    return new Promise((resolve, reject) => {
        https.get(downloadUrl, (res) => {
            if (res.headers['content-encoding'] === 'gzip') {
                const gunzip = zlib.createGunzip();
                let data = '';
                res.pipe(gunzip);
                gunzip.on('data', chunk => data += chunk);
                gunzip.on('end', () => {
                    writeFileSync(outputPath, data);
                    resolve(true);
                });
                gunzip.on('error', reject);
            } else {
                let data = [];
                res.on('data', chunk => data.push(chunk));
                res.on('end', () => {
                    writeFileSync(outputPath, Buffer.concat(data));
                    resolve(true);
                });
            }
        }).on('error', reject);
    });
}

/**
 * Fetch subtitles for a video file
 */
export async function fetchSubtitlesForFile(videoPath, options = {}) {
    const { apiKey, token, languages = ['en', 'cs'], verbose = false } = options;

    const log = verbose ? console.log : () => { };

    if (!existsSync(videoPath)) {
        throw new Error(`Video file not found: ${videoPath}`);
    }

    const videoDir = path.dirname(videoPath);
    const videoName = path.basename(videoPath, path.extname(videoPath));
    const movieInfo = parseFilename(videoPath);

    log(`${c.cyan}🔍 Fetching subtitles for: ${videoName}${c.reset}`);
    log(`   Parsed: "${movieInfo.title}" (${movieInfo.year || 'unknown year'})`);

    // Try to calculate hash for better matching
    let fileHash = null;
    try {
        fileHash = await calculateHash(videoPath);
        log(`   File hash: ${fileHash}`);
    } catch (e) {
        log(`   ${c.yellow}Could not calculate hash: ${e.message}${c.reset}`);
    }

    const results = { downloaded: [], failed: [] };

    for (const lang of languages) {
        const langCode = lang.toLowerCase();
        const langName = langCode === 'en' ? 'English' : langCode === 'cs' ? 'Czech' : lang;

        log(`\n   ${c.cyan}Searching ${langName} subtitles...${c.reset}`);

        try {
            const subtitles = await searchSubtitles(movieInfo, {
                languages: [langCode],
                apiKey,
                moviehash: fileHash
            });

            if (subtitles.length === 0) {
                log(`   ${c.yellow}No ${langName} subtitles found${c.reset}`);
                results.failed.push({ language: lang, error: 'No subtitles found' });
                continue;
            }

            // Pick best match (most downloads)
            const best = subtitles[0];
            log(`   Found ${subtitles.length} results, best: ${best.release || 'unknown'} (${best.downloads} downloads)`);

            // Determine output path
            const ext = best.format || 'srt';
            const subPath = path.join(videoDir, `${videoName}.${langCode}.${ext}`);

            if (!apiKey) {
                log(`   ${c.yellow}⚠️  No API key - showing search results only${c.reset}`);
                log(`   Would download: ${best.release}`);
                results.downloaded.push({ language: lang, path: subPath, preview: true });
                continue;
            }

            // Download
            log(`   Downloading to: ${subPath}`);
            await downloadSubtitle(best.fileId, subPath, { apiKey, token });

            log(`   ${c.green}✅ Downloaded ${langName} subtitles${c.reset}`);
            results.downloaded.push({ language: lang, path: subPath });

        } catch (e) {
            log(`   ${c.red}❌ Error: ${e.message}${c.reset}`);
            results.failed.push({ language: lang, error: e.message });
        }
    }

    return results;
}

/**
 * Process multiple video files
 */
export async function fetchSubtitlesForDirectory(dir, options = {}) {
    const { apiKey, token, languages = ['en', 'cs'], verbose = true, downloadLimit = 5 } = options;

    console.log(`${c.cyan}📂 Scanning: ${dir}${c.reset}`);
    if (downloadLimit > 0) {
        console.log(`   ${c.yellow}⚠️  Safety limit active: Stopping after ${downloadLimit} downloads${c.reset}`);
    }

    const videoExtensions = ['.mkv', '.mp4', '.avi', '.m4v'];
    const results = [];
    let successfulDownloads = 0;

    const files = readdirSync(dir);
    for (const file of files) {
        if (downloadLimit > 0 && successfulDownloads >= downloadLimit) {
            console.log(`\n${c.yellow}🛑 Daily limit reached (${successfulDownloads}/${downloadLimit}). Stopping scan.${c.reset}`);
            break;
        }

        const filePath = path.join(dir, file);
        const stat = statSync(filePath);

        if (stat.isFile() && videoExtensions.includes(path.extname(file).toLowerCase())) {
            // Check if subtitles already exist
            const baseName = path.basename(file, path.extname(file));
            const hasEnSub = existsSync(path.join(dir, `${baseName}.en.srt`));
            const hasCsSub = existsSync(path.join(dir, `${baseName}.cs.srt`));

            const neededLangs = [];
            if (!hasEnSub) neededLangs.push('en');
            if (!hasCsSub) neededLangs.push('cs');

            if (neededLangs.length === 0) {
                if (verbose) console.log(`   ⏭️  ${baseName} - already has subtitles`);
                continue;
            }

            console.log(`\n   🎬 ${baseName}`);
            const result = await fetchSubtitlesForFile(filePath, {
                apiKey,
                token,
                languages: neededLangs,
                verbose
            });
            results.push({ file: filePath, ...result });

            if (result.downloaded && result.downloaded.length > 0) {
                successfulDownloads += result.downloaded.length;
            }

            // Rate limiting
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    return results;
}

// CLI interface
if (process.argv[1]?.includes('subtitle-fetcher')) {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command || command === 'help') {
        console.log(`
${c.cyan}📝 Subtitle Fetcher${c.reset}

Usage:
  node subtitle-fetcher.js fetch <video-file>    Fetch subtitles for a video
  node subtitle-fetcher.js scan <directory>      Scan directory for videos
  node subtitle-fetcher.js test <video-file>     Test search (no download)

Environment:
  OPENSUBTITLES_API_KEY    Your OpenSubtitles.com API key
  OPENSUBTITLES_TOKEN      Optional auth token for higher limits

Get your API key at: https://www.opensubtitles.com/en/consumers
        `);
        process.exit(0);
    }

    const targetPath = args[1];
    const apiKey = process.env.OPENSUBTITLES_API_KEY;

    if (!targetPath) {
        console.log(`${c.red}Error: Please specify a file or directory${c.reset}`);
        process.exit(1);
    }

    if (!apiKey && command !== 'test') {
        console.log(`${c.yellow}Warning: No OPENSUBTITLES_API_KEY set - running in preview mode${c.reset}`);
    }

    (async () => {
        try {
            if (command === 'fetch' || command === 'test') {
                const result = await fetchSubtitlesForFile(targetPath, {
                    apiKey: command === 'test' ? null : apiKey,
                    verbose: true
                });
                console.log(`\n${c.green}Results:${c.reset}`, result);
            } else if (command === 'scan') {
                const results = await fetchSubtitlesForDirectory(targetPath, {
                    apiKey,
                    verbose: true
                });
                console.log(`\n${c.green}Processed ${results.length} files${c.reset}`);
            }
        } catch (e) {
            console.error(`${c.red}Error: ${e.message}${c.reset}`);
            process.exit(1);
        }
    })();
}

export default {
    fetchSubtitlesForFile,
    fetchSubtitlesForDirectory,
    searchSubtitles,
    parseFilename,
    calculateHash
};
