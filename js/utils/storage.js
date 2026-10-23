// JSON values in localStorage, stored LZString-compressed to stretch the storage quota.
// compressToUTF16 rather than compress: localStorage holds UTF-16 strings, and plain compress can
// produce lone surrogate characters that some browsers mangle; the UTF-16 variant only emits
// valid characters.

// The JSON stored under key, or null when it's missing or can't be decompressed or parsed.
const readStoredJson = (key, label) => {
    const stored = localStorage.getItem(key);
    if (!stored) {
        return null;
    }

    try {
        // decompressFromUTF16 returns null or '' for data it can't decompress, which JSON.parse rejects.
        return JSON.parse(LZString.decompressFromUTF16(stored));
    } catch (e) {
        console.error(`Failed to parse ${label}`, e);
        return null;
    }
};

const writeStoredJson = (key, value) => {
    localStorage.setItem(key, LZString.compressToUTF16(JSON.stringify(value)));
};
