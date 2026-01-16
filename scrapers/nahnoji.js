/**
 * Nahnoji.cz Downloader Module
 * 
 * Downloads videos from nahnoji.cz using Playwright to extract video URLs.
 */

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, statSync } from 'fs';
import path from 'path';

// ANSI escape codes for clean progress
const CLEAR_LINE = '\x1b[2K\r';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function progressBar(percent, width = 25) {
    const filled = Math.round(width * percent / 100);
    const empty = width - filled;
    return `${'█'.repeat(filled)}${'░'.repeat(empty)}`;
}

export async function downloadFromNahnoji(videoUrl, outputPath, options = {}) {
    const {
        headless = true,
        timeout = 60000,
        title = path.basename(outputPath, path.extname(outputPath))
    } = options;

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });

    const page = await context.newPage();
    let videoSrc = null;

    try {
        // Monitor network for video URLs
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('.mp4') && !url.includes('thumbnail')) {
                videoSrc = url;
            }
        });

        await page.goto(videoUrl, { waitUntil: 'networkidle', timeout });
        await page.waitForTimeout(2000);

        // Try to find video element
        if (!videoSrc) {
            videoSrc = await page.evaluate(() => {
                const video = document.querySelector('video');
                if (video) return video.src || video.querySelector('source')?.src;
                return null;
            });
        }

        if (!videoSrc) {
            throw new Error('Could not find video URL');
        }

        // Ensure output directory exists
        const outputDir = path.dirname(outputPath);
        if (!existsSync(outputDir)) {
            mkdirSync(outputDir, { recursive: true });
        }

        // Close browser before downloading (free resources)
        await browser.close();

        // Download with curl with progress
        const result = await downloadWithProgress(videoSrc, outputPath, videoUrl, title);
        return result;

    } catch (error) {
        process.stdout.write(`${CLEAR_LINE}`);
        await browser.close().catch(() => { });
        return { success: false, error: error.message };
    }
}

/**
 * Download file using curl with clean progress display
 */
async function downloadWithProgress(url, outputPath, referer, title = '') {
    return new Promise((resolve) => {
        const args = [
            '-L',
            '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            '-H', `Referer: ${referer}`,
            '-o', outputPath,
            '-#',  // Progress bar mode
            url
        ];

        const startTime = Date.now();
        let lastUpdate = 0;

        const curl = spawn('curl', args, {
            stdio: ['pipe', 'pipe', 'pipe']  // Capture all output
        });

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
                    console.log(`   ${CYAN}⬇️  ${displayTitle}${RESET} [${progressBar(percent)}] ${percent.toFixed(0)}%`);
                    lastUpdate = now;
                }
            }
        });

        curl.on('close', (code) => {
            process.stdout.write(`${CLEAR_LINE}`);  // Clear the progress line

            if (code === 0 && existsSync(outputPath)) {
                const stats = statSync(outputPath);
                resolve({
                    success: true,
                    url: url,
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
