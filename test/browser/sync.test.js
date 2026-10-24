// The browser store saving to a real server: changes are sent once edits pause, and two tabs
// editing the same data get a conflict instead of silently overwriting each other.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers.js';
import { openTab } from './syncHarness.js';

let testApp;
let server;
let baseUrl;
let cookie;

const waitFor = async (condition, timeoutMs = 5000) => {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('Timed out waiting.');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};

const openStore = async () => {
    const tab = openTab(baseUrl, cookie);
    const toasts = [];
    const store = tab.useTrackerStore({ showToast: (message, type) => toasts.push({ message, type }) });
    await store.loadSavedData();
    return { tab, store, toasts };
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

describe('browser store syncing', () => {
    it('saves new and changed records once edits pause', async () => {
        const { store } = await openStore();
        expect(store.saveStatus.value).toBe('saved');

        store.scopes.value.push({ id: 1, name: 'Alchs', code: 'const a = 1;', itemTagKeys: [], itemColors: {}, variables: [] });
        store.tags.value.push({ key: 'PROFIT', label: 'Profit' });
        store.itemTags.value.push({ key: 'runes', label: 'Runes', parent: null, items: [554] });
        store.globalsCode.value = 'const tax = 0.02;';
        store.saveData();
        expect(store.saveStatus.value).toBe('pending');

        await waitFor(() => store.saveStatus.value === 'saved');
        const state = await serverState();
        expect(state.scopes.map(record => record.data.name)).toEqual(['Alchs']);
        expect(state.variableTags.map(record => record.data.key)).toEqual(['PROFIT']);
        expect(state.itemTags[0].data.items).toEqual([554]);
        expect(state.globals.data.code).toBe('const tax = 0.02;');
    });

    it('loads what was saved, including settings', async () => {
        const first = await openStore();
        first.tab.editorSettings.lineNumbers = false;
        first.store.dashboardFilterTags.value = ['PROFIT'];
        first.store.saveData();
        await waitFor(() => first.store.saveStatus.value === 'saved');

        const second = await openStore();
        expect(second.store.scopes.value[0]).toMatchObject({ id: '1', name: 'Alchs', code: 'const a = 1;' });
        expect(second.tab.editorSettings.lineNumbers).toBe(false);
        expect(second.store.dashboardFilterTags.value).toEqual(['PROFIT']);
    });

    it('deletes removed records and saves a new order', async () => {
        const { store } = await openStore();
        store.scopes.value.push({ id: 2, name: 'Second', code: '', itemTagKeys: [], itemColors: {}, variables: [] });
        store.saveData();
        await waitFor(() => store.saveStatus.value === 'saved');

        store.scopes.value.reverse();
        store.itemTags.value = [];
        store.saveData();
        await waitFor(() => store.saveStatus.value === 'saved');

        const state = await serverState();
        expect(state.scopes.map(record => record.data.id)).toEqual(['2', '1']);
        expect(state.itemTags).toEqual([]);
    });

    it('stops with a conflict when another tab saved the same record first', async () => {
        const tabA = await openStore();
        const tabB = await openStore();

        tabA.store.scopes.value[0].code = 'const fromA = 1;';
        tabA.store.saveData();
        await waitFor(() => tabA.store.saveStatus.value === 'saved');

        tabB.store.scopes.value[0].code = 'const fromB = 1;';
        tabB.store.saveData();
        await waitFor(() => tabB.store.saveStatus.value === 'conflict');

        // Saving stays stopped until the user decides.
        tabB.store.saveData();
        expect(tabB.store.saveStatus.value).toBe('conflict');
        expect((await serverState()).scopes[0].data.code).toBe('const fromA = 1;');

        tabB.store.keepThisTabsChanges();
        await waitFor(() => tabB.store.saveStatus.value === 'saved');
        expect((await serverState()).scopes[0].data.code).toBe('const fromB = 1;');
    });

    it('re-creates a record deleted in another tab when this tab keeps its version', async () => {
        const tabA = await openStore();
        const tabB = await openStore();
        const deletedId = tabA.store.scopes.value[1].id;

        tabA.store.scopes.value = tabA.store.scopes.value.filter(scope => scope.id !== deletedId);
        tabA.store.saveData();
        await waitFor(() => tabA.store.saveStatus.value === 'saved');

        tabB.store.scopes.value.find(scope => scope.id === deletedId).code = 'const kept = 1;';
        tabB.store.saveData();
        await waitFor(() => tabB.store.saveStatus.value === 'conflict');

        tabB.store.keepThisTabsChanges();
        await waitFor(() => tabB.store.saveStatus.value === 'saved');
        const restored = (await serverState()).scopes.find(record => record.data.id === deletedId);
        expect(restored.data.code).toBe('const kept = 1;');
    });

    it('loads a shared scope read-only and never saves it', async () => {
        const owner = await openStore();
        const scope = owner.store.scopes.value[0];
        const share = await fetch(`${baseUrl}/api/scopes/${scope.id}/share`, {
            method: 'POST',
            headers: { cookie, 'X-Requested-With': 'ge-tracker' },
        });
        const { shareToken } = await share.json();

        const viewer = openTab(baseUrl, '');
        const viewerStore = viewer.useTrackerStore({ showToast: () => {} });
        await viewerStore.loadSharedScope(shareToken);
        expect(viewerStore.scopes.value.map(s => s.name)).toEqual([scope.name]);
        expect(viewerStore.saveStatus.value).toBe('readonly');

        viewerStore.scopes.value[0].code = 'const edited = 1;';
        viewerStore.saveData();
        expect(viewerStore.saveStatus.value).toBe('readonly');
    });
});
