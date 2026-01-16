
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = promisify(exec);

/**
 * Download video from YouTube using yt-dlp
 * @param {string} url - YouTube URL
 * @param {string} outputPath - Full path for output file (including .mkv extension)
 * @returns {Promise<{success: boolean, error?: string, path?: string}>}
 */
export async function downloadFromYoutube(url, outputPath) {
    try {
        // Ensure output dict exists
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        console.log(`🎬 YouTube Download: ${url}`);
        console.log(`   Target: ${outputPath}`);

        // Construct yt-dlp command
        // -f bestvideo+bestaudio/best : Download best video and best audio (separate streams) and merge
        // --merge-output-format mkv   : Merge into MKV
        // -o ...                      : Output path
        const cmd = `yt-dlp -f "bestvideo+bestaudio/best" --merge-output-format mkv -o "${outputPath}" "${url}"`;

        console.log(`   Command: ${cmd}`);

        const { stdout, stderr } = await execAsync(cmd);

        // Check if file exists
        // yt-dlp might append .mkv automatically if not present in template, 
        // but we verify the exact path or path + .mkv
        let finalPath = outputPath;
        if (!fs.existsSync(finalPath) && fs.existsSync(outputPath + '.mkv')) {
            finalPath = outputPath + '.mkv';
        }

        if (fs.existsSync(finalPath)) {
            const stats = fs.statSync(finalPath);
            const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
            console.log(`✅ Download successful: ${sizeMB} MB`);
            return { success: true, path: finalPath, size: stats.size };
        } else {
            return { success: false, error: "Output file not found after download" };
        }

    } catch (error) {
        console.error(`❌ YouTube download failed: ${error.message}`);
        return { success: false, error: error.message };
    }
}
