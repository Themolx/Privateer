#!/usr/bin/env node
/**
 * Jellyfin TV Downloader
 * 
 * Downloads Czech-dubbed TV shows from nahnoji.cz and prehrajto.cz
 * and organizes them for Jellyfin media server.
 * 
 * Usage:
 *   node tv-downloader.js --list                    # List available shows
 *   node tv-downloader.js --show south-park         # Download a show
 *   node tv-downloader.js --all                     # Download all shows
 *   node tv-downloader.js --status                  # Show download status
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync, renameSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ANSI colors
const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    magenta: '\x1b[35m'
};

// ============================================================================
// CONFIGURATION
// ============================================================================

const SHOWS_DIR = path.join(__dirname, 'shows');
const DEFAULT_OUTPUT = './downloads';
const PARALLEL_DOWNLOADS = 1;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function log(msg, color = '') {
    console.log(`${color}${msg}${c.reset}`);
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

function loadShow(filename) {
    const filepath = path.join(SHOWS_DIR, filename);
    return JSON.parse(readFileSync(filepath, 'utf-8'));
}

function saveShow(filename, data) {
    const filepath = path.join(SHOWS_DIR, filename);
    writeFileSync(filepath, JSON.stringify(data, null, 2));
}

function getAllShows() {
    return readdirSync(SHOWS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => ({ filename: f, ...loadShow(f) }));
}

function getJellyfinPath(outputDir, showName, season, episode, title = '') {
    // Jellyfin naming: ShowName/Season XX/ShowName - SXXEXX - Title.mkv
    const seasonFolder = `Season ${String(season).padStart(2, '0')}`;
    const episodeNum = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

    // Clean show name for folder
    const cleanShowName = showName.replace(/[<>:"/\\|?*]/g, '');

    // Build filename
    let filename = `${cleanShowName} - ${episodeNum}`;
    if (title && title.trim()) {
        const cleanTitle = title.replace(/[<>:"/\\|?*]/g, '').substring(0, 50);
        filename += ` - ${cleanTitle}`;
    }
    filename += '.mkv'; // Default to MKV for better subtitle support

    return path.join(outputDir, cleanShowName, seasonFolder, filename);
}

// ============================================================================
// DOWNLOADER
// ============================================================================

async function downloadEpisode(showData, seasonNum, episode, outputDir) {
    const { downloadFromNahnoji } = await import('./downloaders/nahnoji.js');
    const { downloadFromPrehrajto } = await import('./downloaders/prehrajto.js');

    const outputPath = getJellyfinPath(
        outputDir,
        showData.showName,
        seasonNum,
        episode.episode,
        episode.title
    );

    // Check for existing file (MKV or MP4)
    if (existsSync(outputPath)) {
        const stats = statSync(outputPath);
        if (stats.size > 1000000) { // > 1MB means it's probably valid
            return { success: true, skipped: true, path: outputPath };
        }
    }

    // Also check for legacy MP4 if we are now defaulting to MKV
    const legacyPath = outputPath.replace('.mkv', '.mp4');
    if (existsSync(legacyPath)) {
        const stats = statSync(legacyPath);
        if (stats.size > 1000000) {
            return { success: true, skipped: true, path: legacyPath };
        }
    }

    // Ensure directory exists
    mkdirSync(path.dirname(outputPath), { recursive: true });

    let result;
    if (showData.source === 'nahnoji.cz' || episode.url.includes('nahnoji')) {
        result = await downloadFromNahnoji(episode.url, outputPath);
    } else {
        result = await downloadFromPrehrajto(episode.url, outputPath);
    }

    // Auto-Transcode if needed
    // Logic:
    // 1. If crawler flagged it as 'needsTranscode' (usually because it was the only option, or size unknown)
    // 2. OR if the file turned out to be huge (> 600MB for standard ep)
    // BUT: Crucially, verify the ACTUAL downloaded size. If it's small (< 400MB), DO NOT transcode.

    // Auto-Transcode if needed
    // Logic:
    // 1. If crawler flagged it as 'needsTranscode' (usually because it was the only option, or size unknown)
    // 2. OR if the file turned out to be huge (> 600MB for standard ep)
    // BUT: Crucially, verify the ACTUAL downloaded size. If it's small (< 400MB), DO NOT transcode.
    // AND: If it's Anime (isAnime=true), NEVER transcode.

    if (showData.isAnime) {
        log(`   ℹ️  Anime detected - skipping transcode check`, c.magenta);
        return { ...result, path: outputPath };
    }

    const SIZE_THRESHOLD = 600 * 1024 * 1024; // 600 MB
    const SAFETY_THRESHOLD = 400 * 1024 * 1024; // 400 MB - Don't touch anything smaller than this

    const isHuge = result.success && result.size > SIZE_THRESHOLD;
    const flaggedButBigEnough = episode.needsTranscode && result.size > SAFETY_THRESHOLD;

    if (result.success && (isHuge || flaggedButBigEnough)) {
        log(`   ⚠️  Transcoding to SD (Size: ${formatSize(result.size)})...`, c.yellow);
        return await transcodeToSD(outputPath, result);
    } else if (result.success && episode.needsTranscode) {
        log(`   ℹ️  Skipping transcode (File is already small: ${formatSize(result.size)})`, c.green);
    }

    return { ...result, path: outputPath };
}

async function transcodeToSD(inputPath, originalResult) {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    const { statSync, unlinkSync, renameSync } = await import('fs');

    const tempOutput = inputPath.replace('.mkv', '.sd.mkv');

    // FFmpeg: scale to 480p height, preserve aspect ratio, CRF 23 (good quality SD), veryfast preset
    // Copy audio if possible, else aac
    const cmd = `ffmpeg -y -v error -i "${inputPath}" \
        -vf "scale=-2:480" \
        -c:v libx264 -crf 23 -preset veryfast \
        -c:a copy \
        "${tempOutput}"`;

    try {
        await execAsync(cmd);

        // Verify success and replace
        if (existsSync(tempOutput) && statSync(tempOutput).size > 1000) {
            const oldSize = originalResult.size;
            const newSize = statSync(tempOutput).size;

            // Overwrite original
            if (inputPath !== tempOutput) {
                // If original was .mp4 but we output .mkv, ensuring we use standard MKV naming
                // But inputPath is usually what we expect. 
                // If inputPath == tempOutput (not possible due to replace), we are good.

                // Remove original
                unlinkSync(inputPath);
                // Rename temp
                renameSync(tempOutput, inputPath);
            }

            log(`   📉 Transcoded: ${formatSize(oldSize)} -> ${formatSize(newSize)}`, c.green);
            return {
                ...originalResult,
                size: newSize,
                transcoded: true
            };
        } else {
            throw new Error("Transcode output invalid");
        }
    } catch (e) {
        log(`   ❌ Transcode failed: ${e.message}`, c.red);
        // Clean up temp
        if (existsSync(tempOutput)) unlinkSync(tempOutput);
        // Return original result - better HD than nothing
        return originalResult;
    }
}

async function downloadShow(showFilename, outputDir, options = {}) {
    const { dryRun = false, limit = 0 } = options;
    const show = loadShow(showFilename);

    log(`\n${'━'.repeat(60)}`, c.cyan);
    log(`📺 ${show.showName}`, c.bold + c.cyan);
    log(`   Source: ${show.source || 'unknown'}`, c.gray);
    log(`${'━'.repeat(60)}`, c.cyan);

    let downloaded = 0;
    let failed = 0;
    let skipped = 0;
    let total = 0;

    // Collect all pending episodes
    const pending = [];
    for (const season of show.seasons || []) {
        for (const ep of season.episodes || []) {
            if (ep.status !== 'downloaded') {
                pending.push({ season: season.season, episode: ep });
            }
            total++;
        }
    }

    if (pending.length === 0) {
        log(`   ✅ All episodes already downloaded!`, c.green);
        return { downloaded: 0, failed: 0, skipped: total };
    }

    const toDownload = limit > 0 ? pending.slice(0, limit) : pending;
    log(`   📥 Pending: ${toDownload.length} of ${pending.length} episodes`, c.yellow);

    if (dryRun) {
        log(`\n   🔍 DRY RUN - Would download:`, c.magenta);
        for (const { season, episode } of toDownload.slice(0, 10)) {
            const outPath = getJellyfinPath(outputDir, show.showName, season, episode.episode, episode.title);
            log(`      S${String(season).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')} → ${path.basename(outPath)}`, c.gray);
        }
        if (toDownload.length > 10) {
            log(`      ... and ${toDownload.length - 10} more`, c.gray);
        }
        return { downloaded: 0, failed: 0, skipped: 0, dryRun: true };
    }

    // Download in batches
    for (let i = 0; i < toDownload.length; i += PARALLEL_DOWNLOADS) {
        const batch = toDownload.slice(i, i + PARALLEL_DOWNLOADS);

        const results = await Promise.all(
            batch.map(async ({ season, episode }) => {
                const epLabel = `S${String(season).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')}`;
                log(`   ⬇️  ${epLabel} - ${episode.title || 'Untitled'}...`, c.gray);

                const result = await downloadEpisode(show, season, episode, outputDir);

                if (result.skipped) {
                    log(`   ⏭️  ${epLabel} - Already exists`, c.yellow);
                    return { ...result, episode, season };
                } else if (result.success) {
                    log(`   ✅ ${epLabel} - ${formatSize(result.size || 0)}`, c.green);
                    // Update episode status
                    episode.status = 'downloaded';
                    episode.downloadedAt = new Date().toISOString();
                    episode.fileSize = result.size;
                    return { ...result, episode, season };
                } else {
                    log(`   ❌ ${epLabel} - ${result.error || 'Failed'}`, c.red);
                    episode.status = 'failed';
                    episode.error = result.error;
                    return { ...result, episode, season };
                }
            })
        );

        for (const r of results) {
            if (r.skipped) skipped++;
            else if (r.success) downloaded++;
            else failed++;
        }

        // Save progress after each batch
        saveShow(showFilename, show);
    }

    log(`\n   📊 Summary: ✅ ${downloaded} downloaded, ⏭️ ${skipped} skipped, ❌ ${failed} failed`, c.bold);
    return { downloaded, failed, skipped };
}

// ============================================================================
// CLI COMMANDS
// ============================================================================

function showHelp() {
    console.log(`
${c.bold}${c.cyan}🎬 Jellyfin TV Downloader${c.reset}

Download Czech-dubbed TV shows from nahnoji.cz and prehrajto.cz

${c.bold}Usage:${c.reset}
  node tv-downloader.js [options]

${c.bold}Options:${c.reset}
  --list              List all available shows
  --status            Show download status for all shows
  --show <name>       Download a specific show (use filename without .json)
  --all               Download all shows
  --output <path>     Output directory (default: ./downloads)
  --dry-run           Show what would be downloaded without downloading
  --limit <n>         Limit number of episodes to download
  --help              Show this help

${c.bold}Examples:${c.reset}
  ${c.gray}# List available shows${c.reset}
  node tv-downloader.js --list

  ${c.gray}# Download South Park to custom folder${c.reset}
  node tv-downloader.js --show south-park --output ~/Movies/TVShows

  ${c.gray}# Download all shows${c.reset}
  node tv-downloader.js --all --output ./downloads

  ${c.gray}# Preview what would be downloaded${c.reset}
  node tv-downloader.js --show simpsonovi --dry-run

${c.bold}Jellyfin Integration:${c.reset}
  Files are automatically organized as:
  ${c.gray}OutputDir/ShowName/Season XX/ShowName - SXXEXX - Title.mp4${c.reset}
`);
}

function listShows() {
    log('\n📺 Available Shows\n', c.bold + c.cyan);

    const shows = getAllShows();

    console.log('┌────────────────────────────┬───────────┬───────────┬─────────────────┐');
    console.log('│ Show                       │ Episodes  │ Status    │ Source          │');
    console.log('├────────────────────────────┼───────────┼───────────┼─────────────────┤');

    for (const show of shows.sort((a, b) => a.showName.localeCompare(b.showName))) {
        let total = 0, downloaded = 0;
        for (const s of show.seasons || []) {
            for (const e of s.episodes || []) {
                total++;
                if (e.status === 'downloaded') downloaded++;
            }
        }

        const name = show.showName.substring(0, 26).padEnd(26);
        const eps = `${downloaded}/${total}`.padEnd(9);
        const pct = total > 0 ? Math.round(downloaded / total * 100) : 0;
        const status = pct === 100 ? `${c.green}✅ 100%${c.reset}`.padEnd(19) :
            pct > 0 ? `${c.yellow}${pct}%${c.reset}`.padEnd(19) :
                `${c.gray}0%${c.reset}`.padEnd(19);
        const source = (show.source || 'unknown').substring(0, 15).padEnd(15);

        console.log(`│ ${name} │ ${eps} │ ${status} │ ${source} │`);
    }

    console.log('└────────────────────────────┴───────────┴───────────┴─────────────────┘');

    log(`\n💡 Use: node tv-downloader.js --show <filename> --output <path>`, c.gray);
    log(`   Example: node tv-downloader.js --show south-park --output ~/Movies\n`, c.gray);
}

function showStatus() {
    log('\n📊 Download Status\n', c.bold + c.cyan);

    const shows = getAllShows();
    let totalEpisodes = 0, totalDownloaded = 0, totalSize = 0;

    for (const show of shows) {
        let showTotal = 0, showDownloaded = 0, showSize = 0;

        for (const s of show.seasons || []) {
            for (const e of s.episodes || []) {
                showTotal++;
                if (e.status === 'downloaded') {
                    showDownloaded++;
                    showSize += e.fileSize || 0;
                }
            }
        }

        totalEpisodes += showTotal;
        totalDownloaded += showDownloaded;
        totalSize += showSize;

        const pct = showTotal > 0 ? Math.round(showDownloaded / showTotal * 100) : 0;
        const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
        const color = pct === 100 ? c.green : pct > 0 ? c.yellow : c.gray;

        log(`${show.showName.padEnd(25)} ${color}${bar}${c.reset} ${pct}% (${showDownloaded}/${showTotal})`, '');
    }

    log(`\n${'─'.repeat(60)}`, c.gray);
    log(`Total: ${totalDownloaded}/${totalEpisodes} episodes (${formatSize(totalSize)})`, c.bold);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h') || args.length === 0) {
        showHelp();
        return;
    }

    if (args.includes('--list')) {
        listShows();
        return;
    }

    if (args.includes('--status')) {
        showStatus();
        return;
    }

    // Parse options
    const outputIdx = args.indexOf('--output');
    const outputDir = outputIdx !== -1 ? args[outputIdx + 1] : DEFAULT_OUTPUT;

    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : 0;

    const dryRun = args.includes('--dry-run');

    // Download specific show
    const showIdx = args.indexOf('--show');
    if (showIdx !== -1) {
        const showName = args[showIdx + 1];
        const filename = showName.endsWith('.json') ? showName : `${showName}.json`;

        if (!existsSync(path.join(SHOWS_DIR, filename))) {
            log(`❌ Show not found: ${filename}`, c.red);
            log(`   Use --list to see available shows`, c.gray);
            process.exit(1);
        }

        log(`\n🎬 Jellyfin TV Downloader`, c.bold + c.magenta);
        log(`   Output: ${outputDir}`, c.gray);
        if (dryRun) log(`   Mode: DRY RUN`, c.yellow);

        await downloadShow(filename, outputDir, { dryRun, limit });
        return;
    }

    // Download all shows
    if (args.includes('--all')) {
        log(`\n🎬 Jellyfin TV Downloader - Download All`, c.bold + c.magenta);
        log(`   Output: ${outputDir}`, c.gray);
        if (dryRun) log(`   Mode: DRY RUN`, c.yellow);

        const shows = getAllShows();
        let totalDownloaded = 0, totalFailed = 0;

        for (const show of shows) {
            const result = await downloadShow(show.filename, outputDir, { dryRun, limit });
            totalDownloaded += result.downloaded || 0;
            totalFailed += result.failed || 0;
        }

        log(`\n${'═'.repeat(60)}`, c.cyan);
        log(`🏁 All done! Downloaded: ${totalDownloaded}, Failed: ${totalFailed}`, c.bold);
        return;
    }

    showHelp();
}

main().catch(err => {
    console.error(`${c.red}Error: ${err.message}${c.reset}`);
    process.exit(1);
});
