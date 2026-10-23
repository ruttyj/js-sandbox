// ONE-TIME MIGRATION: plain JSON in localStorage -> LZString-compressed (see js/utils/storage.js).
// Remove this file (and its script tag in index.html) once the saved data has been converted.
//
// Runs at load, before anything reads localStorage. A value that parses as JSON is still in the
// old format; compressed values are never valid JSON, so they are left alone.

const LOCAL_STORAGE_KEY_PREFIX = 'osrs-ge-tracker';

const isUncompressedJson = (stored) => {
    try {
        JSON.parse(stored);
        return true;
    } catch (e) {
        return false;
    }
};

const compressOldLocalStorage = () => {
    const keys = Object.keys(localStorage).filter(key => key.startsWith(LOCAL_STORAGE_KEY_PREFIX));
    for (const key of keys) {
        const stored = localStorage.getItem(key);
        if (isUncompressedJson(stored)) {
            localStorage.setItem(key, LZString.compressToUTF16(stored));
        }
    }
};

try {
    compressOldLocalStorage();
} catch (e) {
    console.warn('Could not compress old localStorage data.', e);
}
