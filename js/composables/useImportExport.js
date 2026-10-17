// JSON export/import of item groups, scopes and globals, with merge-or-overwrite on import.
const useImportExport = ({ store, selectedGroupId, showToast }) => {
    const { groups, scopes, globalVariables, globalsCode, saveData } = store;

    const importFile = ref(null); // template ref to the hidden <input type="file">
    const isImportModalVisible = ref(false);
    const pendingImportGroups = ref(null);

    const exportGroups = () => {
        if (groups.value.length === 0 && scopes.value.length === 0 && globalVariables.value.length === 0) {
            showToast("There is no data to export.", 'info');
            return;
        }
        const data = { groups: groups.value, scopes: scopes.value, globals: globalVariables.value, globalsCode: globalsCode.value };
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

    // Accepts the old format (array of groups) and the newer ones ({ groups, scopes?, globals }).
    // Files from before scopes existed have recipes inside their groups; those become scopes.
    const parseImport = (imported) => {
        let parsed;
        if (Array.isArray(imported)) {
            if (!imported.every(g => g.id && g.name && Array.isArray(g.items))) throw new Error('Invalid file format.');
            parsed = { groups: imported, scopes: [], globals: [], globalsCode: null };
        } else if (typeof imported === 'object' && imported !== null) {
            if (!imported.groups && !imported.scopes && !imported.globals) {
                throw new Error('Invalid file format: Missing groups, scopes or globals.');
            }
            parsed = {
                groups: Array.isArray(imported.groups) ? imported.groups : [],
                scopes: Array.isArray(imported.scopes) ? imported.scopes : [],
                globals: Array.isArray(imported.globals) ? imported.globals : [],
                globalsCode: typeof imported.globalsCode === 'string' ? imported.globalsCode : null,
            };
        } else {
            throw new Error('Invalid file format.');
        }
        parsed.scopes = [...parsed.scopes, ...extractLegacyScopes(parsed.groups)];
        parsed.groups.forEach(normalizeGroup);
        parsed.scopes.forEach(normalizeScope);
        return parsed;
    };

    const importGroups = (event) => {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = e => {
            try {
                pendingImportGroups.value = parseImport(JSON.parse(e.target.result));
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

    const mergeGroup = (existingGroup, importedGroup) => {
        const existingItemIds = new Set(existingGroup.items.map(i => i.id));
        importedGroup.items.forEach(importedItem => {
            if (!existingItemIds.has(importedItem.id)) {
                existingGroup.items.push({
                    id: importedItem.id,
                    color: importedItem.color || getRandomVibrantColor(),
                    order: existingGroup.items.length
                });
            }
        });
    };

    const mergeScope = (existingScope, importedScope) => {
        const added = mergeVariables(existingScope.variables, importedScope.variables);
        existingScope.code = appendVariablesToCode(existingScope.code, added);
        existingScope.groupIds = [...new Set([...existingScope.groupIds, ...importedScope.groupIds])];
    };

    // A fresh id that can't clash with existing ones (ids are timestamps).
    const newImportId = () => Date.now() + Math.random();

    const overwriteWithImport = (importedData) => {
        groups.value = importedData.groups;
        scopes.value = importedData.scopes;
        globalVariables.value = importedData.globals.map(normalizeVariable);
        globalsCode.value = importedData.globalsCode ?? generateScopeCode({ variables: globalVariables.value });
        selectedGroupId.value = null;
    };

    // Groups and scopes are matched by name, not id, so exports from other devices merge cleanly.
    // Returns imported group id -> the id that group has now (both as strings).
    const mergeImportedGroups = (importedGroups) => {
        const groupIdMap = new Map();
        importedGroups.forEach(importedGroup => {
            let group = groups.value.find(g => g.name === importedGroup.name);
            if (group) {
                mergeGroup(group, importedGroup);
            } else {
                group = { ...importedGroup, id: newImportId() };
                groups.value.push(group);
            }
            groupIdMap.set(String(importedGroup.id), String(group.id));
        });
        return groupIdMap;
    };

    // groupIdMap: from mergeImportedGroups, so the scopes' group refs point at the merged groups.
    const mergeImportedScopes = (importedScopes, groupIdMap) => {
        importedScopes.forEach(importedScope => {
            importedScope.groupIds = importedScope.groupIds.map(id => groupIdMap.get(id) ?? id);
            const existingScope = scopes.value.find(s => s.name === importedScope.name);
            if (existingScope) mergeScope(existingScope, importedScope);
            else scopes.value.push({ ...importedScope, id: newImportId() });
        });
    };

    const mergeImport = (importedData) => {
        const groupIdMap = mergeImportedGroups(importedData.groups);
        mergeImportedScopes(importedData.scopes, groupIdMap);
        const added = mergeVariables(globalVariables.value, importedData.globals);
        globalsCode.value = appendVariablesToCode(globalsCode.value, added);
    };

    // choice: 'overwrite' | 'merge' (anything else just closes the modal).
    const confirmImport = (choice) => {
        const importedData = pendingImportGroups.value;
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
        pendingImportGroups.value = null;
    };

    return {
        importFile, isImportModalVisible, pendingImportGroups,
        exportGroups, triggerImport, importGroups, confirmImport, cancelImport,
    };
};
