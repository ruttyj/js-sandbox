// Item icons from the OSRS wiki, cached on disk and shared by every user, so each icon is
// downloaded from the wiki once rather than by every browser on every visit.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const WIKI_IMAGE_BASE = 'https://oldschool.runescape.wiki/images/';
const FETCH_TIMEOUT_MS = 10_000;
// The wiki asks API users to say who they are.
const USER_AGENT = 'ge-tracker (self-hosted OSRS Grand Exchange tracker)';

const CONTENT_TYPES = { '.png': 'image/png', '.gif': 'image/gif' };

// An icon file name as the wiki's item mapping gives it ("Abyssal whip.png"): no path separators
// or control characters, so it can only ever name a file in the wiki's image folder.
const ICON_NAME_PATTERN = /^[^/\\\u0000-\u001f]{1,200}\.(png|gif)$/i;

export const isValidIconName = (name) => ICON_NAME_PATTERN.test(name);

// "Abyssal whip.png" -> https://oldschool.runescape.wiki/images/Abyssal_whip.png
const wikiIconUrl = (name) => WIKI_IMAGE_BASE + encodeURIComponent(name.replace(/ /g, '_'));

export class IconManager {
    /**
     * @param {object} options
     * @param {string} options.iconDir  Where downloaded icons are kept.
     * @param {typeof fetch} [options.fetchImpl]  Replaced in tests.
     */
    constructor({ iconDir, fetchImpl = fetch }) {
        this.iconDir = iconDir;
        this.fetchImpl = fetchImpl;
        this.downloads = new Map(); // icon name -> promise of its download, while one is running
        this.missing = new Set(); // names the wiki doesn't have, not asked for again until restart
    }

    // The cached file's path. The name is hashed so any valid name makes a safe file name.
    cachePath(name) {
        const extension = path.extname(name).toLowerCase();
        const hash = crypto.createHash('sha1').update(name).digest('hex');
        return path.join(this.iconDir, hash + extension);
    }

    /**
     * The icon as a file on disk, downloading it first if needed.
     * @returns {Promise<{ filePath: string, contentType: string } | null>} null when the wiki has
     *     no such image (or couldn't be reached).
     */
    async getIcon(name) {
        const filePath = this.cachePath(name);
        const contentType = CONTENT_TYPES[path.extname(name).toLowerCase()];

        if (await fileExists(filePath)) {
            return { filePath, contentType };
        }
        if (this.missing.has(name)) {
            return null;
        }

        const downloaded = await this.downloadOnce(name, filePath);
        if (!downloaded) {
            return null;
        }
        return { filePath, contentType };
    }

    // Several requests for the same icon at once share one download.
    downloadOnce(name, filePath) {
        if (!this.downloads.has(name)) {
            const download = this.download(name, filePath).finally(() => this.downloads.delete(name));
            this.downloads.set(name, download);
        }
        return this.downloads.get(name);
    }

    // Returns whether the icon was saved.
    async download(name, filePath) {
        let response;
        try {
            response = await this.fetchImpl(wikiIconUrl(name), {
                headers: { 'User-Agent': USER_AGENT },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
        } catch (error) {
            console.warn(`Icon download failed for "${name}".`, error.message);
            return false;
        }

        const isImage = (response.headers.get('content-type') || '').startsWith('image/');
        if (response.status === 404 || (response.ok && !isImage)) {
            this.missing.add(name);
            return false;
        }
        if (!response.ok) {
            console.warn(`Icon download failed for "${name}": HTTP ${response.status}.`);
            return false;
        }

        const bytes = Buffer.from(await response.arrayBuffer());
        await writeFileAtomically(filePath, bytes);
        return true;
    }
}

const fileExists = async (filePath) => {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
};

// Written to a temporary file then renamed, so a request never reads a half-written icon.
const writeFileAtomically = async (filePath, bytes) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, bytes);
    await fs.rename(temporaryPath, filePath);
};
