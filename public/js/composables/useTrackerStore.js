// The user's saved data (scopes, global variables and their code, variable tags, item tags, and
// their settings), loaded from and saved to the server.
//
// Saving: the app edits the data in place and calls saveData(). That waits until edits pause
// (SAVE_DELAY_MS), then sends whatever changed since the last save (see recordSync.js). If the
// server says a record was changed somewhere else since this tab loaded it, saving stops and
// saveStatus becomes 'conflict' until the user reloads or keeps this tab's version.
//
// A shared scope (see useSharing) is loaded read-only: nothing is ever saved.
const SAVE_DELAY_MS = 1000;
const SAVE_RETRY_DELAY_MS = 5000;

// What each kind of record saves; the rest of the object is derived or owned by the server
// (a scope's shareToken).
const scopeSaveData = (scope) => ({
    name: scope.name,
    code: scope.code,
    variables: scope.variables,
    itemTagKeys: scope.itemTagKeys,
    itemColors: scope.itemColors,
    colorSeed: scope.colorSeed,
});

const itemTagSaveData = (tag) => ({ label: tag.label, parent: tag.parent ?? null, items: tag.items });

const variableTagSaveData = (tag) => ({ label: tag.label });

// Brings loaded data into the shape the app works with: defaults for missing fields, and every
// variable tag in use present in the tag list. Returns whether tags had to be added.
const normalizeLoadedData = (data) => {
    data.scopes.forEach(normalizeScope);
    data.globals.forEach(normalizeVariable);
    return addMissingTags(data.tags, [...data.scopes.flatMap(s => s.variables), ...data.globals]);
};

const warnBeforeLeavingUnsaved = (saveStatus) => {
    window.addEventListener('beforeunload', (event) => {
        const hasUnsaved = ['pending', 'saving', 'error'].includes(saveStatus.value);
        if (hasUnsaved) {
            event.preventDefault();
            event.returnValue = '';
        }
    });
};

const useTrackerStore = ({ showToast }) => {
    const scopes = ref([]);
    const globalVariables = ref([]); // derived from globalsCode, like a scope's variables from its code
    const globalsCode = ref('');
    const tags = ref([]); // variable tags
    const itemTags = ref([]);
    const dashboardFilterTags = ref([]); // the variable tags the dashboard shows

    // 'loading' until data is loaded, then 'saved' | 'pending' (waiting for edits to pause) |
    // 'saving' | 'error' (will retry) | 'conflict' | 'signed-out' (session ended) | 'readonly'.
    const saveStatus = ref('loading');

    const syncs = {
        variableTags: createCollectionSync({ path: '/api/variable-tags', keyOf: tag => tag.key, toData: variableTagSaveData }),
        itemTags: createCollectionSync({ path: '/api/item-tags', keyOf: tag => tag.key, toData: itemTagSaveData }),
        scopes: createCollectionSync({ path: '/api/scopes', keyOf: scope => scope.id, toData: scopeSaveData }),
        globals: createDocumentSync({
            path: '/api/globals',
            toData: () => ({ code: globalsCode.value, variables: globalVariables.value }),
        }),
        settings: createDocumentSync({
            path: '/api/settings',
            toData: () => ({ editorSettings: { ...editorSettings }, dashboardFilter: dashboardFilterTags.value }),
        }),
    };

    let saveTimer = null;
    let isPushing = false;
    let pushAgain = false; // saveData was called while a push was running

    // --- Saving ---------------------------------------------------------------------------

    const canSave = () => ['saved', 'pending', 'saving', 'error'].includes(saveStatus.value);

    // Variable tags and item tags first, so a scope never arrives before the tags it uses.
    // Returns whether anything conflicted.
    const pushAll = async () => {
        let conflicted = false;
        conflicted = (await syncs.variableTags.push(tags.value)) || conflicted;
        conflicted = (await syncs.itemTags.push(itemTags.value)) || conflicted;
        conflicted = (await syncs.scopes.push(scopes.value)) || conflicted;
        conflicted = (await syncs.globals.push()) || conflicted;
        conflicted = (await syncs.settings.push()) || conflicted;
        return conflicted;
    };

    const scheduleSave = (delay) => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(pushChanges, delay);
    };

    const cancelScheduledSave = () => {
        clearTimeout(saveTimer);
        saveTimer = null;
    };

    // After a successful push: 'pending' when more edits came in meanwhile (their save is
    // already scheduled), else 'saved'.
    const statusAfterPush = (conflicted) => {
        if (conflicted) {
            return 'conflict';
        }
        if (saveTimer !== null) {
            return 'pending';
        }
        return 'saved';
    };

    const onSaveFailed = (error) => {
        if (error instanceof ApiError && error.status === 401) {
            saveStatus.value = 'signed-out';
            showToast('You were signed out. Sign in again to keep saving.', 'error');
            return;
        }

        // The server refused the data itself (e.g. too large): sending it again won't help, so
        // it's only retried with the next edit.
        const isRefused = error instanceof ApiError && error.status >= 400 && error.status < 500;
        if (isRefused) {
            console.error('The server refused a save.', error.body);
            saveStatus.value = 'error';
            showToast(`Some changes couldn't be saved: ${error.message}`, 'error');
            return;
        }

        console.error('Saving failed; retrying.', error);
        saveStatus.value = 'error';
        scheduleSave(SAVE_RETRY_DELAY_MS);
    };

    // Only one push runs at a time; a push asked for meanwhile runs once the current one ends.
    const pushChanges = async () => {
        if (isPushing) {
            pushAgain = true;
            return;
        }
        cancelScheduledSave();
        isPushing = true;
        saveStatus.value = 'saving';

        try {
            const conflicted = await pushAll();
            saveStatus.value = statusAfterPush(conflicted);
        } catch (error) {
            onSaveFailed(error);
        } finally {
            isPushing = false;
        }

        const runAgain = pushAgain && canSave();
        pushAgain = false;
        if (runAgain) {
            pushChanges();
        }
    };

    // Called after every edit. The save itself waits until edits pause.
    const saveData = () => {
        if (!canSave()) {
            return;
        }
        if (!isPushing) {
            saveStatus.value = 'pending';
        }
        scheduleSave(SAVE_DELAY_MS);
    };

    // Saves now rather than after the delay (e.g. before signing out or sharing). A push already
    // running may have started before the latest edits, so it's waited out first.
    const flushPendingSaves = async () => {
        while (isPushing) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (saveStatus.value !== 'pending' && saveStatus.value !== 'error') {
            return;
        }
        await pushChanges();
    };

    // Resolving a conflict: keep this tab's version (overwriting the other changes), or reload
    // and lose this tab's unsaved changes.
    const keepThisTabsChanges = () => {
        Object.values(syncs).forEach(sync => sync.adoptServerVersions());
        saveStatus.value = 'pending';
        pushChanges();
    };

    const reloadFromServer = () => {
        window.location.reload();
    };

    // --- Loading --------------------------------------------------------------------------

    // data: { scopes, globals, globalsCode, tags, itemTags } in the app's shapes.
    const applyLoadedData = (data) => {
        const addedTags = normalizeLoadedData(data);
        scopes.value = data.scopes;
        globalVariables.value = data.globals;
        globalsCode.value = data.globalsCode;
        tags.value = data.tags;
        itemTags.value = data.itemTags;
        return addedTags;
    };

    // Loads the signed-in user's data from the server.
    const loadSavedData = async () => {
        const state = await apiRequest('GET', '/api/state');

        const addedTags = applyLoadedData({
            scopes: state.scopes.map(record => record.data),
            globals: state.globals.data.variables,
            globalsCode: state.globals.data.code,
            tags: state.variableTags.map(record => record.data),
            itemTags: state.itemTags.map(record => record.data),
        });
        applyEditorSettings(state.settings.data.editorSettings);
        dashboardFilterTags.value = state.settings.data.dashboardFilter;

        syncs.scopes.reset(state.scopes);
        syncs.itemTags.reset(state.itemTags);
        syncs.variableTags.reset(state.variableTags);
        syncs.globals.reset(state.globals);
        syncs.settings.reset(state.settings);
        saveStatus.value = 'saved';

        if (addedTags) {
            saveData();
        }
    };

    // Loads a scope shared by link, with its owner's globals and tags, read-only.
    const loadSharedScope = async (token) => {
        saveStatus.value = 'readonly';
        const shared = await apiRequest('GET', `/api/shared/${encodeURIComponent(token)}`);
        applyLoadedData({
            scopes: [shared.scope],
            globals: shared.globals.variables,
            globalsCode: shared.globals.code,
            tags: shared.variableTags,
            itemTags: shared.itemTags,
        });
    };

    // Settings edits save like any other change.
    watch(editorSettings, saveData);
    watch(dashboardFilterTags, saveData, { deep: true });
    warnBeforeLeavingUnsaved(saveStatus);

    return {
        scopes, globalVariables, globalsCode, tags, itemTags, dashboardFilterTags, saveStatus,
        saveData, flushPendingSaves, keepThisTabsChanges, reloadFromServer, loadSavedData, loadSharedScope,
    };
};
