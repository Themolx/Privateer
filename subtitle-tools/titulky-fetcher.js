/**
 * Titulky.com Scraper Module
 * 
 * Scrapes subtitles from titulky.com using Playwright.
 * Bypasses API limits by automating the browser interaction.
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import Tesseract from 'tesseract.js';
import readline from 'readline';

// Config
const TITULKY_BASE = 'https://www.titulky.com';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_PATH = path.join(__dirname, '.titulky-cookies.json');

// Manual CAPTCHA mode - set to true to open browser for manual solving
const MANUAL_CAPTCHA = process.env.TITULKY_MANUAL === '1';
// Direct CAPTCHA code - pass via env var or read from file
const CAPTCHA_CODE = process.env.TITULKY_CAPTCHA || null;
const CAPTCHA_FILE = path.join(__dirname, '.captcha-code.txt');

// Colors
const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m'
};

function log(msg, color = '') {
    console.log(`${color}${msg}${c.reset}`);
}

/**
 * Save cookies for session persistence
 */
async function saveCookies(context) {
    try {
        const cookies = await context.cookies();
        writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
        log(`   💾 Saved ${cookies.length} cookies`, c.gray);
    } catch (e) {
        log(`   ⚠️ Failed to save cookies: ${e.message}`, c.yellow);
    }
}

/**
 * Load cookies for session persistence
 */
async function loadCookies(context) {
    try {
        if (existsSync(COOKIES_PATH)) {
            const cookies = JSON.parse(readFileSync(COOKIES_PATH, 'utf-8'));
            await context.addCookies(cookies);
            log(`   🍪 Loaded ${cookies.length} saved cookies`, c.gray);
            return true;
        }
    } catch (e) {
        log(`   ⚠️ Failed to load cookies: ${e.message}`, c.yellow);
    }
    return false;
}

/**
 * Solve image CAPTCHA using local Tesseract OCR (FREE)
 */
async function solveCaptchaOCR(page) {
    try {
        // Find the CAPTCHA image - try multiple selectors
        let captchaImg = await page.$('img[src*="captcha"], img[src*="kod"], img[src*="image"]');
        
        if (!captchaImg) {
            // Look for image inside the form with captcha input
            captchaImg = await page.$('form img, td img, .captcha img');
        }
        
        if (!captchaImg) {
            log(`   ⚠️ Could not locate CAPTCHA image element`, c.yellow);
            return null;
        }

        const imgSrc = await captchaImg.getAttribute('src');
        log(`   🖼️ CAPTCHA image: ${imgSrc}`, c.gray);

        // Screenshot the captcha element
        const imgBuffer = await captchaImg.screenshot();

        log(`   🔍 Running local OCR (Tesseract)...`, c.cyan);
        const result = await Tesseract.recognize(imgBuffer, 'eng', {
            logger: () => {} // Suppress logs
        });

        // Clean up the result - remove spaces, newlines, keep alphanumeric
        const text = result.data.text.replace(/[^a-zA-Z0-9]/g, '').trim();
        
        if (text.length >= 3 && text.length <= 8) {
            log(`   ✅ OCR result: ${text}`, c.green);
            return text;
        } else {
            log(`   ⚠️ OCR result unreliable: "${text}" (len=${text.length})`, c.yellow);
            return null;
        }

    } catch (e) {
        log(`   ❌ OCR failed: ${e.message}`, c.red);
        return null;
    }
}

/**
 * Prompt user for input in terminal
 */
function askQuestion(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

/**
 * Manual CAPTCHA solving - saves image and asks user in terminal
 */
async function solveCaptchaManual(page) {
    try {
        // Find and screenshot the CAPTCHA image
        const captchaImg = await page.$('img[src*="captcha"], img[src*="kod"], form img, td img');
        if (!captchaImg) {
            log(`   ❌ Could not find CAPTCHA image`, c.red);
            return null;
        }
        
        // Save CAPTCHA to temp file
        const captchaPath = path.join(__dirname, '.captcha-temp.png');
        await captchaImg.screenshot({ path: captchaPath });
        
        log(`   🖼️  CAPTCHA saved to: ${captchaPath}`, c.cyan);
        log(`   👀 Open the image and enter the code below:`, c.yellow);
        
        // Open the image (macOS)
        const { exec } = await import('child_process');
        exec(`open "${captchaPath}"`);
        
        // Ask user for the code
        const code = await askQuestion('   Enter CAPTCHA code: ');
        
        if (code && code.length >= 3) {
            return code;
        }
        return null;
    } catch (e) {
        log(`   ❌ Manual CAPTCHA error: ${e.message}`, c.red);
        return null;
    }
}

/**
 * Search for subtitles on Titulky.com
 */
async function searchTitulky(query) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: USER_AGENT });
    
    // Load saved cookies for session persistence
    await loadCookies(context);
    
    const page = await context.newPage();

    try {
        const searchUrl = `${TITULKY_BASE}/index.php?Fulltext=${encodeURIComponent(query)}`;
        /* log(`   Navigating to: ${searchUrl}`, c.gray); */
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });

        // Parse results
        const results = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('tr.r, tr.r1'));
            return rows.map(row => {
                const cols = row.querySelectorAll('td');
                if (cols.length < 6) return null;

                const titleLink = cols[0].querySelector('a');
                if (!titleLink) return null;

                const title = titleLink.innerText.trim();
                const url = titleLink.href;

                // Release info often in tooltip in 2nd column
                const releaseLink = cols[1].querySelector('a.listTip');
                const release = releaseLink ? releaseLink.getAttribute('title') : '';

                const year = cols[3].innerText.trim();
                const downloads = parseInt(cols[4].innerText.replace(/\s/g, '')) || 0;

                // Language check (skip if not CZ/SK if needed, but for now just scrape all)
                // const langImg = cols[5].querySelector('img');
                // const lang = langImg ? langImg.alt : '';

                return {
                    title,
                    url,
                    year,
                    version: release || title, // Use release if available, else title
                    downloads
                };
            }).filter(Boolean);
        });

        /* log(`   Found ${results.length} results`, c.gray); */
        return results;

    } catch (e) {
        log(`   Error searching: ${e.message}`, c.red);
        return [];
    } finally {
        await browser.close();
    }
}

/**
 * Login to Titulky.com
 */
async function login(page) {
    const user = process.env.TITULKY_USER;
    const pass = process.env.TITULKY_PASS;

    if (!user || !pass) {
        log(`   ⚠️  No TITULKY_USER/TITULKY_PASS found. Expecting CAPTCHA issues.`, c.yellow);
        return false;
    }

    log(`   🔑 Logging in as ${user}...`, c.cyan);
    try {
        await page.goto(TITULKY_BASE, { waitUntil: 'domcontentloaded' });

        // Handle Cookie Consent (Didomi)
        try {
            const consentBtn = await page.waitForSelector('#didomi-notice-agree-button', { timeout: 5000 });
            if (consentBtn) {
                log(`   🍪 Accepting cookies...`, c.gray);
                await consentBtn.click();
                await page.waitForTimeout(1000); // Wait for banner to fade
            }
        } catch (e) {
            // No banner or timeout, proceed
        }

        // Fill login form
        await page.fill('#log_login', user);
        await page.fill('#log_password', pass);

        // Click login
        await page.click('input[name="prihlasit"]');

        // Wait for reload/navigation
        await page.waitForLoadState('domcontentloaded');

        // Check for success (look for 'odhlásit' or user link)
        const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
        const loggedIn = bodyText.includes('odhlásit') || bodyText.includes('logout');

        if (loggedIn) {
            log(`   ✅ Login successful`, c.green);
            // Save cookies after successful login
            await saveCookies(page.context());
        } else {
            const html = await page.content();
            log(`   ❌ Login failed. Page text excerpt: ${await page.evaluate(() => document.body.innerText.substring(0, 500).replace(/\s+/g, ' '))}`, c.red);
            log(`   ❌ HTML dump: ${html.substring(0, 1000)}...`, c.gray);
            return false;
        }
    } catch (e) {
        log(`   ❌ Login error: ${e.message}`, c.red);
        return false;
    }
}

/**
 * Download subtitle from detail page URL
 */
async function downloadFromUrl(url, targetPath) {
    // Use visible browser if manual CAPTCHA mode enabled
    const browser = await chromium.launch({ headless: !MANUAL_CAPTCHA });
    const context = await browser.newContext({ userAgent: USER_AGENT });
    
    // Load saved cookies for session persistence
    await loadCookies(context);
    
    const page = await context.newPage();

    let downloadPath = null;
    let tempDir = path.dirname(targetPath);

    try {
        // Try to login first to avoid Captcha (skip if cookies loaded)
        const hasCookies = existsSync(COOKIES_PATH);
        if (!hasCookies) {
            await login(page);
        } else {
            log(`   🍪 Using saved session, skipping login`, c.gray);
        }

        // Continue with download
        /* log(`   Opening detail page...`, c.gray); */
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        // Wait for download link
        // Link usually looks like: https://www.titulky.com/idown.php?R=...&zip=z
        // We look for a link containing 'idown.php' and 'zip=z' (or similar)

        let downloadUrl = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="idown.php"]'));
            // Find the one that actually downloads
            const dlLink = links.find(l => l.href.includes('zip='));
            return dlLink ? dlLink.href : null;
        });

        if (!downloadUrl) {
            // Try simpler match if specific zip param missing
            downloadUrl = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href*="idown.php"]'));
                // Usually the download link is a prominent link often labeled 'Stáhnout', 'Download' or has specific ID
                // Fallback: take the first idown link that is NOT a history entry or something small
                return links[0] ? links[0].href : null;
            });
        }

        if (!downloadUrl) {
            throw new Error('Download link not found on page');
        }

        /* log(`   Found download URL: ${downloadUrl}`, c.gray); */

        // Navigate to the countdown page
        await page.goto(downloadUrl, { waitUntil: 'domcontentloaded' });

        // Check for CAPTCHA on the download page
        const isSecured = await page.evaluate(() => document.querySelector('input[name="downkod"]') !== null);
        if (isSecured) {
            const html = await page.content();
            if (html.includes('Byl překročen denní limit')) {
                log(`   ⚠️ Daily IP limit exceeded - attempting CAPTCHA solve...`, c.yellow);
            } else {
                log(`   ⚠️ Visual Captcha detected - attempting solve...`, c.yellow);
            }

            // Save CAPTCHA image first
            const captchaImg = await page.$('img[src*="captcha"], img[src*="kod"], form img, td img');
            const captchaPath = path.join(__dirname, '.captcha-temp.png');
            if (captchaImg) {
                await captchaImg.screenshot({ path: captchaPath });
                log(`   🖼️  CAPTCHA saved: ${captchaPath}`, c.cyan);
            }

            // File-watch mode: wait for code in .captcha-code.txt
            if (process.env.TITULKY_WAIT === '1') {
                log(`   ⏳ Waiting for code in .captcha-code.txt (delete file first, then create with code)`, c.yellow);
                // Delete old code file
                if (existsSync(CAPTCHA_FILE)) rmSync(CAPTCHA_FILE);
                
                // Wait up to 60s for code file to appear
                let code = null;
                for (let i = 0; i < 60 && !code; i++) {
                    await page.waitForTimeout(1000);
                    if (existsSync(CAPTCHA_FILE)) {
                        code = readFileSync(CAPTCHA_FILE, 'utf-8').trim();
                        if (code) log(`   🔑 Got code from file: ${code}`, c.green);
                    }
                }
                
                if (code) {
                    await page.fill('input[name="downkod"]', code);
                    const submitBtn = await page.$('input[type="submit"], button[type="submit"], input[name="odeslat"]');
                    if (submitBtn) {
                        await submitBtn.click();
                        await page.waitForLoadState('domcontentloaded');
                        const stillSecured = await page.evaluate(() => document.querySelector('input[name="downkod"]') !== null);
                        if (!stillSecured) {
                            log(`   ✅ CAPTCHA solved!`, c.green);
                            await saveCookies(context);
                        } else {
                            log(`   ❌ CAPTCHA rejected`, c.red);
                            return false;
                        }
                    }
                } else {
                    log(`   ❌ Timeout waiting for code`, c.red);
                    return false;
                }
            }
            // Try direct code, manual, or OCR
            else if (CAPTCHA_CODE) {
                // Direct code provided via env var
                log(`   🔑 Using provided CAPTCHA code: ${CAPTCHA_CODE}`, c.cyan);
                await page.fill('input[name="downkod"]', CAPTCHA_CODE);
                const submitBtn = await page.$('input[type="submit"], button[type="submit"], input[name="odeslat"]');
                if (submitBtn) {
                    await submitBtn.click();
                    await page.waitForLoadState('domcontentloaded');
                    const stillSecured = await page.evaluate(() => document.querySelector('input[name="downkod"]') !== null);
                    if (stillSecured) {
                        log(`   ❌ CAPTCHA code rejected`, c.red);
                        return false;
                    }
                    log(`   ✅ CAPTCHA solved!`, c.green);
                    await saveCookies(context);
                }
            } else if (MANUAL_CAPTCHA) {
                // Manual mode - saves CAPTCHA image and prompts user in terminal
                const manualCode = await solveCaptchaManual(page);
                if (manualCode) {
                    await page.fill('input[name="downkod"]', manualCode);
                    const submitBtn = await page.$('input[type="submit"], button[type="submit"], input[name="odeslat"]');
                    if (submitBtn) {
                        await submitBtn.click();
                        await page.waitForLoadState('domcontentloaded');
                        const stillSecured = await page.evaluate(() => document.querySelector('input[name="downkod"]') !== null);
                        if (stillSecured) {
                            log(`   ❌ CAPTCHA rejected`, c.red);
                            return false;
                        }
                        log(`   ✅ CAPTCHA solved!`, c.green);
                        await saveCookies(context);
                    }
                } else {
                    return false;
                }
            } else {
                // Try automatic OCR with retries - try multiple case variations
                const MAX_OCR_ATTEMPTS = 10;
                let captchaSolved = false;
                
                for (let attempt = 1; attempt <= MAX_OCR_ATTEMPTS && !captchaSolved; attempt++) {
                    log(`   🔄 OCR attempt ${attempt}/${MAX_OCR_ATTEMPTS}...`, c.cyan);
                    
                    const captchaSolution = await solveCaptchaOCR(page);
                    if (!captchaSolution) {
                        log(`   ⚠️ OCR failed, reloading CAPTCHA...`, c.yellow);
                        await page.goto(downloadUrl, { waitUntil: 'domcontentloaded' });
                        continue;
                    }
                    
                    // Try the OCR result as-is, then lowercase, then uppercase
                    const variations = [captchaSolution, captchaSolution.toLowerCase(), captchaSolution.toUpperCase()];
                    
                    for (const variant of variations) {
                        if (captchaSolved) break;
                        
                        await page.fill('input[name="downkod"]', variant);
                        
                        const submitBtn = await page.$('input[type="submit"], button[type="submit"], input[name="odeslat"]');
                        if (!submitBtn) continue;
                        
                        await submitBtn.click();
                        await page.waitForLoadState('domcontentloaded');
                        
                        const stillSecured = await page.evaluate(() => document.querySelector('input[name="downkod"]') !== null);
                        if (!stillSecured) {
                            log(`   ✅ CAPTCHA solved with: ${variant}`, c.green);
                            await saveCookies(context);
                            captchaSolved = true;
                            break;
                        }
                    }
                    
                    if (!captchaSolved) {
                        log(`   ⚠️ CAPTCHA rejected, getting fresh CAPTCHA...`, c.yellow);
                        await page.goto(downloadUrl, { waitUntil: 'domcontentloaded' });
                        await page.waitForTimeout(300);
                    }
                }
                
                if (!captchaSolved) {
                    log(`   ❌ All OCR attempts failed. Try: TITULKY_MANUAL=1`, c.red);
                    return false;
                }
            }
        }

        // Wait for countdown (approx 15-20s)
        log(`   Waiting for countdown...`, c.gray);
        await page.waitForTimeout(20000);

        // Get the actual download link from the page
        let finalDownloadUrl = await page.evaluate(() => {
            const link = document.getElementById('downlink');
            return link ? link.href : null;
        });

        if (!finalDownloadUrl) {
            // Try to force display block to see if it appears
            await page.evaluate(() => {
                const div = document.getElementById('downdiv');
                if (div) div.style.display = 'block';
            });
            finalDownloadUrl = await page.evaluate(() => document.getElementById('downlink')?.href);
        }

        if (!finalDownloadUrl) {
            const html = await page.content();
            log(`   ❌ Page dump: ${html.substring(0, 1500)}...`, c.gray);
            throw new Error('Download link not found after countdown');
        }

        log(`   Downloading from: ${finalDownloadUrl}`, c.gray);

        // Start download - set up listener first, then trigger
        const downloadPromise = page.waitForEvent('download', { timeout: 30000 });

        // Trigger download - goto may throw "Download is starting" which is expected
        try {
            await page.goto(finalDownloadUrl, { timeout: 10000 });
        } catch (e) {
            // Expected error when download starts instead of navigation
            if (!e.message.includes('Download')) {
                throw e;
            }
        }

        const download = await downloadPromise;
        const tempZip = path.join(tempDir, `temp_${Date.now()}.zip`);
        await download.saveAs(tempZip);
        downloadPath = tempZip;

        /* log(`   Downloaded ZIP: ${tempZip}`, c.gray); */

        // Extract ZIP
        const zip = new AdmZip(tempZip);
        const zipEntries = zip.getEntries();

        // Find .srt file
        const srtEntry = zipEntries.find(entry => entry.entryName.endsWith('.srt') || entry.entryName.endsWith('.sub'));

        if (!srtEntry) {
            throw new Error('No .srt/.sub file found in ZIP');
        }

        // Extract to target
        /* log(`   Extracting: ${srtEntry.entryName} -> ${path.basename(targetPath)}`, c.gray); */
        writeFileSync(targetPath, srtEntry.getData());

        return true;

    } catch (e) {
        log(`   Error downloading: ${e.message}`, c.red);
        return false;
    } finally {
        if (downloadPath && existsSync(downloadPath)) {
            rmSync(downloadPath);
        }
        await browser.close();
    }
}

/**
 * Main function to find and download subtitles for a file
 */
export async function fetchTitulky(filename, targetDir) {
    if (!filename) return false;

    // Parse filename for cleaner query
    // e.g. "The.Matrix.1999.1080p.mkv" -> "The Matrix 1999"
    const cleanName = filename
        .replace(/\.(mkv|mp4|avi)$/i, '')
        .replace(/[._-]/g, ' ')
        // Remove common keywords to keep search clean
        .replace(/\b(1080p|720p|bluray|web-dl|x264|hevc|aac)\b.*/i, '')
        .trim();

    log(`🔍 Searching Titulky.com for: "${cleanName}"`, c.cyan);

    const results = await searchTitulky(cleanName);

    if (results.length === 0) {
        log(`   ❌ No results found.`, c.yellow);
        return false;
    }

    log(`   Found ${results.length} candidates. Picking first match.`, c.gray);
    // TODO: Add smarter matching logic (checking release name match)

    const best = results[0];
    log(`   🎯 Selected: ${best.title}`, c.green);

    // Target path
    const targetPath = path.join(targetDir, `${filename.replace(/\.[^/.]+$/, "")}.cs.srt`);

    const success = await downloadFromUrl(best.url, targetPath);

    if (success) {
        log(`   ✅ Saved to: ${path.basename(targetPath)}`, c.green);
        return true;
    } else {
        log(`   ❌ Download failed.`, c.red);
        return false;
    }
}

// CLI if run directly
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const cmd = args[0];

    if (cmd === 'search') {
        searchTitulky(args[1]).then(res => console.log(res));
    } else if (cmd === 'download') {
        const url = args[1];
        const target = args[2] || 'output.srt';
        downloadFromUrl(url, target).then(ok => console.log(ok ? 'Done' : 'Failed'));
    } else if (cmd === 'fetch') {
        fetchTitulky(path.basename(args[1]), path.dirname(args[1]));
    } else {
        console.log('Usage: node titulky-fetcher.js <search|download|fetch> ...');
    }
}

export default { fetchTitulky, searchTitulky };
