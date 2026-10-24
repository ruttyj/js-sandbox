// Importing the data the browser-only version left in localStorage into the signed-in account.
import LZString from 'lz-string';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers.js';
import { openTab } from './syncHarness.js';

let testApp;
let server;
let baseUrl;
let cookie;

const memoryStorage = (entries = {}) => {
    const items = new Map(Object.entries(entries));
    return {
        getItem: (key) => (items.has(key) ? items.get(key) : null),
        setItem: (key, value) => items.set(key, String(value)),
        has: (key) => items.has(key),
    };
};

const OLD_DATA = {
    scopes: [{
        id: 1700000000000,
        name: 'Old scope',
        code: 'const profit = 5;',
        variables: [{ key: 'profit', name: 'profit', color: '#00ff00', tags: ['PROFIT', 'UNLISTED'] }],
        itemTagKeys: [],
    }],
    globals: [{ key: 'tax', name: 'tax', color: '#ff0000', tags: [] }],
    globalsCode: 'const tax = 0.02;',
    tags: [{ key: 'PROFIT', label: 'Profit (gp)' }],
    itemTags: [{ key: 'my-herbs', label: 'My herbs', parent: null, items: [199] }],
};

const waitFor = async (condition, timeoutMs = 5000) => {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('Timed out waiting.');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};

// A signed-in tab with this localStorage, its data loaded.
const openImportTab = async (localStorage) => {
    const tab = openTab(baseUrl, cookie, { localStorage, LZString });
    const toasts = [];
    const showToast = (message, type) => toasts.push({ message, type });
    const store = tab.useTrackerStore({ showToast });
    await store.loadSavedData();
    const importExport = tab.useImportExport({ store, showToast });
    return { store, importExport, toasts };
};

const serverState = async () => {
    const response = await fetch(`${baseUrl}/api/state`, { headers: { cookie } });
    return response.json();
};

beforeAll(async () => {
    testApp = await createTestApp();
    server = testApp.app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const signIn = await fetch(`${baseUrl}/auth/dev`, { redirect: 'manual' });
    cookie = signIn.headers.get('set-cookie').split(';')[0];
});

afterAll(async () => {
    server.close();
    await testApp.destroy();
});

describe('importing from localStorage', () => {
    it('finds nothing to suggest in a browser without old data', async () => {
        const { importExport } = await openImportTab(memoryStorage());
        expect(importExport.hasLocalBrowserData.value).toBe(false);
        expect(importExport.isLocalImportSuggested.value).toBe(false);
    });

    it('imports the compressed format and stops suggesting it', async () => {
        const storage = memoryStorage({ 'osrs-ge-tracker-data': LZString.compressToUTF16(JSON.stringify(OLD_DATA)) });
        const { store, importExport } = await openImportTab(storage);
        expect(importExport.isLocalImportSuggested.value).toBe(true);

        await importExport.importFromBrowserStorage();
        expect(importExport.isImportModalVisible.value).toBe(true);
        importExport.confirmImport('overwrite');
        await waitFor(() => store.saveStatus.value === 'saved');

        const state = await serverState();
        expect(state.scopes.map(record => record.data.name)).toEqual(['Old scope']);
        expect(state.globals.data.code).toBe('const tax = 0.02;');
        expect(state.itemTags.map(record => record.data.key)).toEqual(['my-herbs']);
        // The saved label is kept; a tag only variables used is added under its key.
        expect(state.variableTags.map(record => record.data)).toEqual([
            { key: 'PROFIT', label: 'Profit (gp)' },
            { key: 'UNLISTED', label: 'UNLISTED' },
        ]);

        expect(importExport.isLocalImportSuggested.value).toBe(false);
        expect(storage.has('osrs-ge-tracker-imported-to-account')).toBe(true);
        expect(storage.has('osrs-ge-tracker-data')).toBe(true); // left in place to import again

        const later = await openImportTab(storage);
        expect(later.importExport.hasLocalBrowserData.value).toBe(true);
        expect(later.importExport.isLocalImportSuggested.value).toBe(false);
    });

    it('merges the earliest format: plain JSON under the old split keys', async () => {
        const oldGlobals = [{ key: 'fee', name: 'fee', color: '#0000ff', tags: [] }];
        const storage = memoryStorage({ 'osrs-ge-tracker-globals': JSON.stringify(oldGlobals) });
        const { store, importExport } = await openImportTab(storage);

        await importExport.importFromBrowserStorage();
        importExport.confirmImport('merge');
        await waitFor(() => store.saveStatus.value === 'saved');

        const state = await serverState();
        expect(state.globals.data.variables.map(variable => variable.key)).toEqual(['tax', 'fee']);
        expect(state.scopes.map(record => record.data.name)).toEqual(['Old scope']);
    });

    it('reports data it cannot read instead of importing it', async () => {
        const { importExport, toasts } = await openImportTab(memoryStorage({ 'osrs-ge-tracker-data': 'not json or lz' }));
        await importExport.importFromBrowserStorage();
        expect(importExport.isImportModalVisible.value).toBe(false);
        expect(toasts.at(-1).type).toBe('error');
    });
});
