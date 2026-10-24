// Reading data saved by the browser-only version of the app, which kept everything in this
// browser's localStorage, so it can be imported into the user's account (see useImportExport).
//
// That version saved, over time:
//   osrs-ge-tracker-data     { scopes, globals, globalsCode, tags, itemTags, groups?, itemTagEdits? },
//                            as plain JSON at first, later LZString-compressed (compressToUTF16)
//   osrs-ge-tracker-groups   item groups, and osrs-ge-tracker-globals, global variables: the
//                            earliest versions, before everything shared one key (plain JSON)
// The data is never deleted here, so it stays available to import again.
const LOCAL_DATA_KEY = 'osrs-ge-tracker-data';
const LOCAL_OLD_GROUPS_KEY = 'osrs-ge-tracker-groups';
const LOCAL_OLD_GLOBALS_KEY = 'osrs-ge-tracker-globals';
// Set once the data has been imported, so the app stops suggesting it.
const LOCAL_IMPORTED_FLAG_KEY = 'osrs-ge-tracker-imported-to-account';

// LZString is only needed for this, so it's loaded on demand rather than on every page load.
const LZ_STRING_URL = 'https://unpkg.com/lz-string@1.5.0/libs/lz-string.min.js';

const readLocalStorageItem = (key) => {
    try {
        return localStorage.getItem(key);
    } catch (error) {
        // Storage can be blocked entirely (privacy settings); that just means there's nothing to import.
        return null;
    }
};

const hasLocalStorageData = () => {
    return readLocalStorageItem(LOCAL_DATA_KEY) !== null
        || readLocalStorageItem(LOCAL_OLD_GROUPS_KEY) !== null
        || readLocalStorageItem(LOCAL_OLD_GLOBALS_KEY) !== null;
};

const wasLocalStorageImported = () => readLocalStorageItem(LOCAL_IMPORTED_FLAG_KEY) !== null;

const markLocalStorageImported = () => {
    try {
        localStorage.setItem(LOCAL_IMPORTED_FLAG_KEY, new Date().toISOString());
    } catch (error) {
        console.warn('Could not note the browser data as imported.', error);
    }
};

const loadLzString = () => new Promise((resolve, reject) => {
    if (window.LZString) {
        resolve(window.LZString);
        return;
    }
    const script = document.createElement('script');
    script.src = LZ_STRING_URL;
    script.onload = () => resolve(window.LZString);
    script.onerror = () => reject(new Error('Could not load the decompressor for the saved data.'));
    document.head.appendChild(script);
});

// A stored value: plain JSON, else LZString-compressed JSON. Throws when it's neither.
const decodeLocalStorageValue = async (stored) => {
    try {
        return JSON.parse(stored);
    } catch (error) {
        // Not plain JSON, so it's the compressed format.
    }

    const lzString = await loadLzString();
    // decompressFromUTF16 returns null or '' for data it can't decompress. That has to be caught
    // here: JSON.parse(null) quietly returns null rather than throwing.
    const decompressed = lzString.decompressFromUTF16(stored);
    if (!decompressed) {
        throw new Error("The data saved in this browser couldn't be read.");
    }
    return JSON.parse(decompressed);
};

/**
 * The browser-only version's saved data, in a shape the import accepts (see readImportedData in
 * useImportExport), or null when this browser has none. Throws when it exists but can't be read.
 */
const readLocalStorageData = async () => {
    const stored = readLocalStorageItem(LOCAL_DATA_KEY);
    if (stored !== null) {
        return decodeLocalStorageValue(stored);
    }

    const oldGroups = readLocalStorageItem(LOCAL_OLD_GROUPS_KEY);
    const oldGlobals = readLocalStorageItem(LOCAL_OLD_GLOBALS_KEY);
    if (oldGroups === null && oldGlobals === null) {
        return null;
    }
    return {
        groups: oldGroups === null ? [] : await decodeLocalStorageValue(oldGroups),
        globals: oldGlobals === null ? [] : await decodeLocalStorageValue(oldGlobals),
    };
};
