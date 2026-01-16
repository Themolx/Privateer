/**
 * TV Archiver - Prehrajto.cz Downloader Module
 * 
 * Downloads videos from prehrajto.cz with better quality detection
 * and proper handling of the video player.
 */

import { chromium } from 'playwright';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync, statSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';

const execAsync = promisify(exec);

// ANSI escape codes for clean progress
const CLEAR_LINE = '\x1b[2K\r';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec <= 0) return '-- MB/s';
    const mbps = bytesPerSec / (1024 * 1024);
    return `${mbps.toFixed(1)} MB/s`;
}

function progressBar(percent, width = 25) {
    const filled = Math.round(width * percent / 100);
    const empty = width - filled;
    return `${'█'.repeat(filled)}${'░'.repeat(empty)}`;
}

/**
 * Downloads a video from prehrajto.cz
 * @param {string} pageUrl - The video page URL
 * @param {string} outputPath - Full path to save the video
 * @param {object} options - Download options
 * @returns {Promise<{success: boolean, size: number, error?: string}>}
 */
export async function downloadFromPrehrajto(pageUrl, outputPath, options = {}) {
    const {
        headless = true,
        timeout = 120000,
        quality = 'highest', // 'highest', 'lowest', or specific resolution
        onProgress = null,
        verbose = false,
        title = path.basename(outputPath, path.extname(outputPath))
    } = options;

    const log = verbose ? console.log : () => { };

    log('🚀 Launching browser...');

    const browser = await chromium.launch({
        headless,
        args: ['--disable-blink-features=AutomationControlled']
    });

    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 }
        });

        const page = await context.newPage();

        log(`📄 Navigating to: ${pageUrl}`);

        // Capture all video URLs from network
        const videoUrls = [];
        const capturedSubtitles = [];

        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('.mp4') && (url.includes('premiumcdn') || url.includes('cdn'))) {
                const contentLength = response.headers()['content-length'];
                videoUrls.push({
                    url,
                    size: contentLength ? parseInt(contentLength) : 0
                });
                log(`🎬 Found video URL (${contentLength ? Math.round(parseInt(contentLength) / 1024 / 1024) + 'MB' : 'unknown size'})`);
            }
        });

        // Capture subtitles from requests
        page.on('request', request => {
            const url = request.url();
            // Broader check for debugging
            if (url.match(/(\.vtt|\.srt|subyt|caption)/i)) {
                log(`📝 [DEBUG] Request matched subtitle pattern: ${url}`);
                capturedSubtitles.push(url);
            }
        });


        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout });

        // Wait for page to settle
        await page.waitForTimeout(2000);

        // Try to click the play button
        log('▶️  Looking for play button...');

        const playButtonSelectors = [
            'button:has-text("Přehrát")',
            'button:has-text("Přehrát video")',
            'text=Přehrát video',
            '.play-button',
            '[data-action="play"]',
            '.vjs-big-play-button',
            'button[class*="play"]',
            '.player-play'
        ];

        for (const selector of playButtonSelectors) {
            try {
                const button = await page.$(selector);
                if (button) {
                    await button.click();
                    log(`   Clicked: ${selector}`);
                    break;
                }
            } catch (e) {
                // Try next selector
            }
        }

        // Wait for video to start loading
        log('⏳ Waiting for video to load...');
        await page.waitForTimeout(8000);

        // Also try to find video URL from page
        const pageVideoUrl = await page.evaluate(() => {
            // Check video elements
            const video = document.querySelector('video');
            if (video && video.src && video.src.includes('.mp4')) {
                return video.src;
            }

            const source = document.querySelector('video source[type="video/mp4"]');
            if (source && source.src) {
                return source.src;
            }

            // Check performance entries
            const entries = window.performance.getEntriesByType('resource');
            for (const entry of entries) {
                if (entry.name.includes('.mp4') && (entry.name.includes('premiumcdn') || entry.name.includes('cdn'))) {
                    return entry.name;
                }
            }

            return null;
        });

        if (pageVideoUrl && !videoUrls.find(v => v.url === pageVideoUrl)) {
            videoUrls.push({ url: pageVideoUrl, size: 0 });
        }

        if (videoUrls.length === 0) {
            throw new Error('Could not find video URL');
        }

        // Select the best quality (largest file)
        let selectedUrl;
        if (quality === 'highest') {
            // Sort by size descending and pick the first with known size, or just first
            const sorted = videoUrls.sort((a, b) => b.size - a.size);
            selectedUrl = sorted[0].url;
        } else if (quality === 'lowest') {
            const sorted = videoUrls.filter(v => v.size > 0).sort((a, b) => a.size - b.size);
            selectedUrl = sorted.length > 0 ? sorted[0].url : videoUrls[0].url;
        } else {
            selectedUrl = videoUrls[0].url;
        }

        log(`📥 Selected video URL`);
        log(`📁 Downloading to: ${outputPath}`);

        // Pass captured subtitles to the download function
        options.capturedSubtitles = capturedSubtitles;

        await browser.close();

        // Ensure output directory exists
        const outputDir = path.dirname(outputPath);
        if (!existsSync(outputDir)) {
            mkdirSync(outputDir, { recursive: true });
        }

        // Download using curl with progress
        // Only download video if no subtitles found, otherwise download both and merge

        // Collect ALL unique subtitle URLs
        const allSubs = new Set();
        videoUrls.forEach(v => {
            if (v.url.includes('.vtt') || v.url.includes('.srt')) allSubs.add(v.url);
        });


        // Use the LOCAL capturedSubtitles array, not options
        if (capturedSubtitles.length > 0) log(`🔍 Intercepted ${capturedSubtitles.length} subtitle requests.`);

        capturedSubtitles.forEach(s => {
            if (s.includes('.vtt') || s.includes('.srt')) allSubs.add(s);
        });

        // Filter and Deduplicate Subtitles logic
        // Rule: Only keep CZ, SK, EN. Max 1-2 per language.
        const candidates = [];
        allSubs.forEach(url => {
            const lower = url.toLowerCase();
            let lang = null;
            let score = 0; // Higher is better

            if (lower.match(/(_|\.|-)cz/) || lower.match(/(_|\.|-)cze/) || lower.includes('czech')) {
                lang = 'cze'; score = 10;
            } else if (lower.match(/(_|\.|-)sk/) || lower.match(/(_|\.|-)svk/) || lower.includes('slovak')) {
                lang = 'slo'; score = 8;
            } else if (lower.match(/(_|\.|-)en/) || lower.match(/(_|\.|-)eng/) || lower.includes('english')) {
                lang = 'eng'; score = 10; // Equal priority to Czech
            } else if (lower.includes('forced')) {
                // Try to guess forced lang or just treat as valuable
                score = 6;
                lang = 'forced';
            } else {
                // Fallback for encrypted/hashed URLs (common on Prehrajto)
                // Treat as "Unknown" but keep it to allow manual check.
                // We will limit total count later.
                lang = 'unknown';
                score = 1;
            }

            // Always add candidates (we will slice later)
            // Prevent exact duplicates
            if (!candidates.find(c => c.url === url)) {
                candidates.push({ url, lang, score });
            }
        });

        // Unique by language, keeping highest score (or first if equal)
        // Actually, sometimes we want multiple (Forced + Full).
        // Let's just take top 3 distinct URLs sorted by score.
        const subtitleUrls = candidates
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map(c => c.url);

        if (subtitleUrls.length > 0) {
            const count = subtitleUrls.length;
            log(`📝 Found ${count} relevant subtitle track(s) (Filtered from ${allSubs.size})`);
            return await downloadAndMerge(selectedUrl, subtitleUrls, outputPath, pageUrl, title);
        } else {
            // Fallback: If we found subtitles but filtered them all out (e.g. unknown lang), 
            // maybe just take the first one if we have nothing else?
            // "we only want czech and english subtitles" -> So NO fallback to unknown.

            if (allSubs.size > 0) {
                log(`   ⚠️  Ignored ${allSubs.size} subtitle tracks (Language not CZ/EN)`, YELLOW);
            }
            // Normal download to MKV (or MP4 then rename)
            // Since outputPath is now .mkv, we download to .mp4 temp and then move/remux
            const tempMp4 = outputPath.replace('.mkv', '.temp.mp4');
            const result = await downloadWithCurl(selectedUrl, tempMp4, pageUrl, title);

            if (result.success) {
                // If target is MKV, remux it
                if (outputPath.endsWith('.mkv')) {
                    process.stdout.write(`${CLEAR_LINE}   🔄 Remuxing to MKV...`);
                    try {
                        await execAsync(`ffmpeg -y -v error -i "${tempMp4}" -c copy "${outputPath}"`);
                        // clean up temp
                        if (existsSync(tempMp4)) unlinkSync(tempMp4);
                        process.stdout.write(`${CLEAR_LINE}`);
                        return { ...result, size: statSync(outputPath).size };
                    } catch (e) {
                        process.stdout.write(`${CLEAR_LINE}`);
                        log(`⚠️ Remux failed, keeping MP4: ${e.message}`);
                        return result; // Return MP4 result (caller might need to handle ext mismatch)
                    }
                }
            }
            return result;
        }

    } catch (error) {
        if (browser) await browser.close();
        return {
            success: false,
            size: 0,
            error: error.message
        };
    }
}

/**
 * Download video and MULTIPLE subtitles, then merge into MKV
 * @param {string} videoUrl 
 * @param {string[]} subtitleUrls - Array of subtitle URLs
 * @param {string} outputPath 
 * @param {string} referer 
 * @param {string} title 
 */
async function downloadAndMerge(videoUrl, subtitleUrls, outputPath, referer, title) {
    const tempVideo = outputPath.replace('.mkv', '.temp.mp4');
    let subFiles = [];

    // 1. Download Video
    const vidResult = await downloadWithCurl(videoUrl, tempVideo, referer, title + ' (video)');
    if (!vidResult.success) return vidResult;

    // 2. Download All Subtitles
    process.stdout.write(`${CLEAR_LINE}   📝 Downloading ${subtitleUrls.length} subtitles...`);

    let subIndex = 0;
    for (const url of subtitleUrls) {
        const ext = url.includes('.srt') ? '.srt' : '.vtt';
        const subPath = outputPath.replace('.mkv', `.sub${subIndex}${ext}`);
        const subResult = await downloadWithCurlSilent(url, subPath, referer);

        if (subResult.success) {
            subFiles.push(subPath);
            subIndex++;
        }
    }
    process.stdout.write(`${CLEAR_LINE}`);

    if (subFiles.length > 0) {
        process.stdout.write(`${CLEAR_LINE}   🔄 Merging ${subFiles.length} subs into MKV...`);
        try {
            // Build FFmpeg inputs: -i vid -i sub0 -i sub1 ...
            let inputs = `-i "${tempVideo}"`;
            let maps = `-map 0:v -map 0:a`; // Map video and audio from first input
            let metadata = ``;

            subFiles.forEach((file, idx) => {
                inputs += ` -i "${file}"`;
                // Subtitle inputs start at index 1 (0 is video)
                const streamIdx = idx + 1;
                maps += ` -map ${streamIdx}`;

                // Try to deduce language/title from the original URL if possible, or file path
                // Note: file path is generic temp name, we need the URL from the list
                const originalUrl = subtitleUrls[idx] || '';
                const lowerUrl = originalUrl.toLowerCase();

                let lang = 'cze'; // Default to Czech on Prehrajto
                let trackTitle = 'Czech';

                if (lowerUrl.includes('en.') || lowerUrl.includes('eng.') || lowerUrl.includes('english') || lowerUrl.includes('_en')) {
                    lang = 'eng';
                    trackTitle = 'English';
                } else if (lowerUrl.includes('sk.') || lowerUrl.includes('svk.') || lowerUrl.includes('slovak') || lowerUrl.includes('_sk')) {
                    lang = 'slo';
                    trackTitle = 'Slovak';
                } else if (lowerUrl.includes('jp.') || lowerUrl.includes('jap.') || lowerUrl.includes('japanese')) {
                    lang = 'jpn';
                    trackTitle = 'Japanese';
                } else if (lowerUrl.includes('forced')) {
                    trackTitle = 'Czech (Forced)';
                } else if (subtitleUrls.length > 1) {
                    // If multiple and no clear language, fallback to numbering
                    trackTitle = `Subtitle ${idx + 1}`;
                }

                metadata += ` -metadata:s:s:${idx} language=${lang}`;
                metadata += ` -metadata:s:s:${idx} title="${trackTitle}"`;

                if (idx === 0) metadata += ` -disposition:s:${idx} default`;
            });

            // Merge command
            // Note: -c:s srt converts all subs (vtt/srt) to srt inside mkv
            const cmd = `ffmpeg -y -v error ${inputs} \
                -c copy -c:s srt \
                ${maps} \
                ${metadata} \
                "${outputPath}"`;

            await execAsync(cmd);

            // Cleanup temp files
            if (existsSync(tempVideo)) unlinkSync(tempVideo);
            subFiles.forEach(f => {
                if (existsSync(f)) unlinkSync(f);
            });

            process.stdout.write(`${CLEAR_LINE}`);
            const stats = statSync(outputPath);
            return {
                success: true,
                size: stats.size,
                sizeMB: (stats.size / (1024 * 1024)).toFixed(2)
            };

        } catch (e) {
            process.stdout.write(`${CLEAR_LINE}`);
            console.log(`   ❌ Merge failed: ${e.message}`);
            // Fallback: keep separate files if merge fails
            return {
                success: true,
                size: vidResult.size,
                error: "Merge failed, saved as separate files"
            };
        }
    }

    return vidResult;
}

/**
 * Download file using curl with clean progress display
 */
async function downloadWithCurl(url, outputPath, referer, title = '') {
    return new Promise((resolve) => {
        const args = [
            '-L',
            '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            '-H', `Referer: ${referer}`,
            '-o', outputPath,
            '-w', '%{size_download} %{speed_download}',  // Write stats at end
            '-#',  // Progress bar mode
            url
        ];

        const startTime = Date.now();
        let lastUpdate = 0;

        const curl = spawn('curl', args, {
            stdio: ['pipe', 'pipe', 'pipe']  // Capture all output
        });

        let downloadedBytes = 0;
        let downloadSpeed = 0;

        // Parse curl's progress bar output from stderr
        curl.stderr.on('data', (data) => {
            const str = data.toString();
            // curl progress format: ###   3.5%
            const match = str.match(/(\d+\.?\d*)%/);
            if (match) {
                const percent = parseFloat(match[1]);
                const now = Date.now();

                // Throttle updates to every 2 seconds for parallel downloads
                if (now - lastUpdate > 2000) {
                    const displayTitle = title.length > 30 ? title.substring(0, 27) + '...' : title;
                    // Use newline to avoid overlap with other parallel downloads
                    console.log(`   ${CYAN}⬇️  ${displayTitle}${RESET} [${progressBar(percent)}] ${percent.toFixed(0)}%`);
                    lastUpdate = now;
                }
            }
        });

        // Capture final stats from stdout
        curl.stdout.on('data', (data) => {
            const str = data.toString().trim();
            const parts = str.split(' ');
            if (parts.length >= 2) {
                downloadedBytes = parseInt(parts[0]) || 0;
                downloadSpeed = parseFloat(parts[1]) || 0;
            }
        });

        curl.on('close', (code) => {
            process.stdout.write(`${CLEAR_LINE}`);  // Clear the progress line

            if (code === 0 && existsSync(outputPath)) {
                const stats = statSync(outputPath);
                resolve({
                    success: true,
                    size: stats.size,
                    sizeMB: (stats.size / (1024 * 1024)).toFixed(2)
                });
            } else {
                resolve({
                    success: false,
                    size: 0,
                    error: `curl exited with code ${code}`
                });
            }
        });

        curl.on('error', (err) => {
            process.stdout.write(`${CLEAR_LINE}`);
            resolve({
                success: false,
                size: 0,
                error: err.message
            });
        });
    });
}

/**
 * Silent download (for subtitles etc)
 */
async function downloadWithCurlSilent(url, outputPath, referer) {
    return new Promise((resolve) => {
        const args = [
            '-L', '-s',
            '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            '-H', `Referer: ${referer}`,
            '-o', outputPath,
            url
        ];

        const curl = spawn('curl', args);

        curl.on('close', (code) => {
            if (code === 0 && existsSync(outputPath)) {
                const stats = statSync(outputPath);
                resolve({
                    success: true,
                    size: stats.size
                });
            } else {
                resolve({
                    success: false,
                    size: 0,
                    error: `curl exited with code ${code}`
                });
            }
        });

        curl.on('error', (err) => {
            resolve({
                success: false,
                size: 0,
                error: err.message
            });
        });
    });
}

export default { downloadFromPrehrajto };
