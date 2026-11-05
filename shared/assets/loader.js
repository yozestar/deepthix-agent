/**
 * Server-side asset decoders — shared between Vite plugin, extension host,
 * and future standalone backends.
 *
 * Reads PNG files from an assets directory and decodes them into SpriteData
 * format using the shared pngDecoder module.
 */
import * as fs from 'fs';
import * as path from 'path';
import { decodeCharacterPng, decodeFloorPng, parseWallPng, pngToSpriteData } from './pngDecoder.js';
// ── Helpers ──────────────────────────────────────────────────────────────────
function listSortedPngs(dir, pattern) {
    if (!fs.existsSync(dir))
        return [];
    const files = [];
    for (const entry of fs.readdirSync(dir)) {
        const match = pattern.exec(entry);
        if (match) {
            files.push({ index: parseInt(match[1], 10), filename: entry });
        }
    }
    return files.sort((a, b) => a.index - b.index);
}
// ── Decoders ─────────────────────────────────────────────────────────────────
export function decodeAllCharacters(assetsDir) {
    const charDir = path.join(assetsDir, 'characters');
    const files = listSortedPngs(charDir, /^char_(\d+)\.png$/i);
    return files.map(({ filename }) => {
        const pngBuffer = fs.readFileSync(path.join(charDir, filename));
        return decodeCharacterPng(pngBuffer);
    });
}
export function decodeAllFloors(assetsDir) {
    const floorsDir = path.join(assetsDir, 'floors');
    const files = listSortedPngs(floorsDir, /^floor_(\d+)\.png$/i);
    return files.map(({ filename }) => {
        const pngBuffer = fs.readFileSync(path.join(floorsDir, filename));
        return decodeFloorPng(pngBuffer);
    });
}
export function decodeAllWalls(assetsDir) {
    const wallsDir = path.join(assetsDir, 'walls');
    const files = listSortedPngs(wallsDir, /^wall_(\d+)\.png$/i);
    return files.map(({ filename }) => {
        const pngBuffer = fs.readFileSync(path.join(wallsDir, filename));
        return parseWallPng(pngBuffer);
    });
}
export function decodeAllFurniture(assetsDir, catalog) {
    const sprites = {};
    for (const entry of catalog) {
        try {
            const filePath = path.join(assetsDir, entry.furniturePath);
            if (!fs.existsSync(filePath))
                continue;
            const pngBuffer = fs.readFileSync(filePath);
            sprites[entry.id] = pngToSpriteData(pngBuffer, entry.width, entry.height);
        }
        catch (err) {
            console.warn(`[decodeAssets] Failed to decode ${entry.id}:`, err);
        }
    }
    return sprites;
}
//# sourceMappingURL=loader.js.map