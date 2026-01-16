#!/usr/bin/env node
/**
 * SMART MOVIE DOWNLOADER v2.0
 * 
 * Features:
 * - Reads wanted movies from wanted_movies.json
 * - Compares against existing files (SSD + HDD inventory)
 * - Self-healing: tries multiple links per movie
 * - Shows clear status report
 * 
 * Usage: node smart-download.js [--status | --download | --missing]
 */

import { downloadFromPrehrajto } from './downloaders/prehrajto.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    wantedFile: path.join(__dirname, 'wanted_movies.json'),
    hddInventoryFile: path.join(__dirname, 'hdd_inventory.json'),
    outputMovies: './downloads',
    outputTV: './downloads',
};

// ============================================
// HELPERS
// ============================================
function loadJSON(filepath) {
    try {
        if (fs.existsSync(filepath)) {
            return JSON.parse(fs.readFileSync(filepath, 'utf8'));
        }
    } catch (e) {
        console.error(`⚠️  Could not load ${path.basename(filepath)}: ${e.message}`);
    }
    return null;
}

function fileExists(directory, filename) {
    const target = path.join(directory, filename);
    return fs.existsSync(target);
}

function getExistingMovies(outputDir, hddInventory) {
    const existing = new Set();

    // Check SSD
    if (fs.existsSync(outputDir)) {
        fs.readdirSync(outputDir).forEach(file => {
            if (file.endsWith('.mkv') || file.endsWith('.mp4')) {
                existing.add(file);
            }
        });
    }

    // Check HDD inventory
    if (hddInventory?.movies) {
        hddInventory.movies.forEach(m => existing.add(m.name));
    }

    return existing;
}

// ============================================
// STATUS REPORT
// ============================================
function showStatus(wanted, existing) {
    console.log('\n📊 MOVIE INVENTORY STATUS');
    console.log('='.repeat(60));

    const categories = {};
    let totalWanted = 0;
    let totalHave = 0;
    let totalMissing = 0;

    for (const movie of wanted.movies || []) {
        const cat = movie.category || 'other';
        if (!categories[cat]) {
            categories[cat] = { have: [], missing: [] };
        }

        const hasIt = existing.has(movie.filename);
        if (hasIt) {
            categories[cat].have.push(movie);
            totalHave++;
        } else {
            categories[cat].missing.push(movie);
            totalMissing++;
        }
        totalWanted++;
    }

    // Print by category
    for (const [cat, data] of Object.entries(categories).sort()) {
        console.log(`\n📁 ${cat.toUpperCase()}`);

        data.have.forEach(m => console.log(`   ✅ ${m.title} (${m.year})`));
        data.missing.forEach(m => console.log(`   ❌ ${m.title} (${m.year})`));
    }

    console.log('\n' + '='.repeat(60));
    console.log(`📈 TOTAL: ${totalHave}/${totalWanted} movies (${totalMissing} missing)`);
    console.log('='.repeat(60));

    return { totalWanted, totalHave, totalMissing };
}

// ============================================
// DOWNLOAD LOGIC
// ============================================
async function downloadMovie(movie, outputDir) {
    const target = path.join(outputDir, movie.filename);

    console.log(`\n⬇️  ${movie.title} (${movie.year})`);

    for (let i = 0; i < movie.links.length; i++) {
        const link = movie.links[i];
        console.log(`   🔗 Link ${i + 1}/${movie.links.length}...`);

        try {
            // downloadFromPrehrajto expects FULL FILE PATH as second argument
            await downloadFromPrehrajto(link, target);

            // Verify file was created
            if (fs.existsSync(target)) {
                const stats = fs.statSync(target);
                const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
                console.log(`   ✅ Done (${sizeMB} MB)`);
                return true;
            } else {
                console.log(`   ⚠️  File not created, trying next link...`);
            }
        } catch (e) {
            console.log(`   ❌ Failed: ${e.message}`);
        }
    }

    console.log(`   ❌ All links failed for: ${movie.title}`);
    return false;
}

async function downloadMissing(wanted, existing, outputDir) {
    const missing = (wanted.movies || []).filter(m => !existing.has(m.filename));

    if (missing.length === 0) {
        console.log('\n🎉 All movies already downloaded!');
        return;
    }

    // Sort by priority
    missing.sort((a, b) => (a.priority || 99) - (b.priority || 99));

    console.log(`\n🎬 Downloading ${missing.length} missing movies...\n`);

    let success = 0;
    let failed = 0;

    for (const movie of missing) {
        const result = await downloadMovie(movie, outputDir);
        if (result) {
            success++;
        } else {
            failed++;
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log(`✅ Downloaded: ${success} | ❌ Failed: ${failed}`);
    console.log('='.repeat(60));
}

// ============================================
// MAIN
// ============================================
async function main() {
    const args = process.argv.slice(2);
    const mode = args[0] || '--download';

    console.log('🌙 SMART MOVIE DOWNLOADER v2.0');
    console.log('='.repeat(60));

    // Load data
    const wanted = loadJSON(CONFIG.wantedFile);
    if (!wanted) {
        console.error('❌ Could not load wanted_movies.json');
        process.exit(1);
    }
    console.log(`📋 Loaded ${wanted.movies?.length || 0} wanted movies`);

    const hddInventory = loadJSON(CONFIG.hddInventoryFile);
    if (hddInventory) {
        console.log(`📁 Loaded HDD inventory: ${hddInventory.movies?.length || 0} movies`);
    }

    // Check SSD
    if (!fs.existsSync(CONFIG.outputMovies)) {
        console.error('❌ SSD not mounted!');
        process.exit(1);
    }
    console.log(`💾 Output: ${CONFIG.outputMovies}`);

    // Get existing movies
    const existing = getExistingMovies(CONFIG.outputMovies, hddInventory);
    console.log(`📂 Found ${existing.size} existing movies`);

    // Execute based on mode
    switch (mode) {
        case '--status':
            showStatus(wanted, existing);
            break;

        case '--missing':
            const missing = (wanted.movies || []).filter(m => !existing.has(m.filename));
            console.log(`\n❌ Missing ${missing.length} movies:`);
            missing.forEach(m => console.log(`   - ${m.title} (${m.year})`));
            break;

        case '--download':
        default:
            showStatus(wanted, existing);
            await downloadMissing(wanted, existing, CONFIG.outputMovies);
            break;
    }
}

main().catch(console.error);
