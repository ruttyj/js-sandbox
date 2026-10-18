// JSON export/import of scopes, globals and the user's item tags, with merge-or-overwrite on import.
const useImportExport = ({ store, showToast }) => {
    const { scopes, globalVariables, globalsCode, itemTags, saveData } = store;

    const importFile = ref(null); // template ref to the hidden <input type="file">
    const isImportModalVisible = ref(false);
    const pendingImport = ref(null);

    const hasDataToExport = () => {
        return scopes.value.length > 0
            || globalVariables.value.length > 0
            || itemTags.value.length > 0;
    };

    const exportData = () => {
        if (!hasDataToExport()) {
            showToast("There is no data to export.", 'info');
            return;
        }
        const data = {
            scopes: scopes.value,
            globals: globalVariables.value,
            globalsCode: globalsCode.value,
            itemTags: itemTags.value,
        };
        const dataBlob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `osrs-ge-tracker-data-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const triggerImport = () => importFile.value.click();

    // The file's contents in the current shape. Accepts every format the app has exported: an
    // array of item groups (oldest), { groups, scopes?, globals, globalsCode? }, the first item-tags
    // version (with itemTagEdits), and the current { scopes, globals, globalsCode, itemTags }.
    // Groups become user item tags.
    const readImportedData = (imported) => {
        if (Array.isArray(imported)) {
            if (!imported.every(g => g.id && g.name && Array.isArray(g.items))) {
                throw new Error('Invalid file format.');
            }
            return { groups: imported, scopes: [], globals: [], globalsCode: null };
        }
        if (typeof imported !== 'object' || imported === null) {
            throw new Error('Invalid file format.');
        }
        const knownKeys = ['groups', 'scopes', 'globals', 'itemTags', 'itemTagEdits'];
        if (!knownKeys.some(key => imported[key])) {
            throw new Error('Invalid file format: nothing to import.');
        }
        return {
            groups: Array.isArray(imported.groups) ? imported.groups : [],
            scopes: Array.isArray(imported.scopes) ? imported.scopes : [],
            globals: Array.isArray(imported.globals) ? imported.globals : [],
            globalsCode: typeof imported.globalsCode === 'string' ? imported.globalsCode : null,
            itemTags: imported.itemTags,
            itemTagEdits: imported.itemTagEdits,
        };
    };

    // Files from before scopes existed have recipes inside their groups; those become scopes.
    const parseImport = (imported) => {
        const parsed = readImportedData(imported);
        parsed.scopes = [...parsed.scopes, ...extractLegacyScopes(parsed.groups)];
        normalizeItemTagData(parsed);
        // groupsToItemTags migration: exports made before item tags carry groups.
        migrateGroupsToItemTags(parsed);
        parsed.scopes.forEach(normalizeScope);
        return parsed;
    };

    const importData = (event) => {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = e => {
            try {
                pendingImport.value = parseImport(JSON.parse(e.target.result));
                isImportModalVisible.value = true;
            } catch (err) {
                console.error(err);
                showToast(err.message || 'Failed to import file.', 'error');
            }
        };
        reader.onerror = () => showToast('Failed to read the file.', 'error');
        reader.readAsText(file);
        importFile.value.value = ''; // allow re-importing the same file
    };

    // Adds variables whose key doesn't already exist in `target`; returns the ones added.
    const mergeVariables = (target, incoming) => {
        const existingKeys = new Set(target.map(v => v.key));
        const added = incoming.filter(v => !existingKeys.has(v.key)).map(normalizeVariable);
        target.push(...added);
        return added;
    };

    // The code is the source of truth, so merged variables are appended to it too.
    const appendVariablesToCode = (code, added) =>
        (added.length ? (code || '').trimEnd() + '\n\n' + generateScopeCode({ variables: added }) : code);

    // Linked tags are combined; an item color already set here is kept.
    const mergeScope = (existingScope, importedScope) => {
        const added = mergeVariables(existingScope.variables, importedScope.variables);
        existingScope.code = appendVariablesToCode(existingScope.code, added);
        existingScope.itemTagKeys = [...new Set([...existingScope.itemTagKeys, ...importedScope.itemTagKeys])];
        existingScope.itemColors = { ...importedScope.itemColors, ...existingScope.itemColors };
    };

    // A fresh id that can't clash with existing ones (ids are timestamps).
    const newImportId = () => Date.now() + Math.random();

    // Scopes are matched by name, not id, so exports from other devices merge cleanly.
    const mergeImportedScopes = (importedScopes) => {
        importedScopes.forEach(importedScope => {
            const existingScope = scopes.value.find(s => s.name === importedScope.name);
            if (existingScope) mergeScope(existingScope, importedScope);
            else scopes.value.push({ ...importedScope, id: newImportId() });
        });
    };

    // User tags are matched by key: a tag that exists here keeps its label and parent and gains
    // the imported tag's items.
    const mergeImportedItemTags = (importedTags) => {
        for (const imported of importedTags) {
            const existing = itemTags.value.find(tag => tag.key === imported.key);
            if (existing) {
                existing.items = [...new Set([...existing.items, ...imported.items])];
            } else {
                itemTags.value.push(imported);
            }
        }
    };

    const mergeImport = (importedData) => {
        mergeImportedItemTags(importedData.itemTags);
        mergeImportedScopes(importedData.scopes);
        const added = mergeVariables(globalVariables.value, importedData.globals);
        globalsCode.value = appendVariablesToCode(globalsCode.value, added);
    };

    const overwriteWithImport = (importedData) => {
        scopes.value = importedData.scopes;
        globalVariables.value = importedData.globals.map(normalizeVariable);
        globalsCode.value = importedData.globalsCode ?? generateScopeCode({ variables: globalVariables.value });
        itemTags.value = importedData.itemTags;
    };

    // choice: 'overwrite' | 'merge' (anything else just closes the modal).
    const confirmImport = (choice) => {
        const importedData = pendingImport.value;
        if (choice === 'overwrite') {
            overwriteWithImport(importedData);
            showToast('Data overwritten successfully!', 'success');
        } else if (choice === 'merge') {
            mergeImport(importedData);
            showToast('Data merged successfully!', 'success');
        }
        saveData();
        cancelImport();
    };

    const cancelImport = () => {
        isImportModalVisible.value = false;
        pendingImport.value = null;
    };

    return {
        importFile, isImportModalVisible, pendingImport,
        exportData, triggerImport, importData, confirmImport, cancelImport,
    };
};
