// Scopes tab: a scope is one block of code (stored on `scope.code`) that runs live, top to
// bottom; its top-level declarations are its variables. A scope can link item tags; their items
// are listed to draw from, but don't limit the code (getOsrsItem reaches any item). Each scope
// colors its items: by hand, or automatically from their tags (see itemColors.js). The Global
// Vars tab edits the globals the same way (see useVariables) and reuses registerVariableTags.

// Inserts text at the caret of a FormulaInput (or appends it when there's no editor), then
// restores the caret after it. codeRef: a writable ref/computed holding the code.
const insertIntoCodeEditor = (editorRef, codeRef, text) => {
    const el = editorRef.value?.textareaRef;
    const code = codeRef.value || '';
    const start = el ? el.selectionStart : code.length;
    const end = el ? el.selectionEnd : code.length;
    codeRef.value = code.slice(0, start) + text + code.slice(end);
    if (el) {
        nextTick(() => {
            el.focus();
            el.setSelectionRange(start + text.length, start + text.length);
        });
    }
};

const useScopes = ({ store, items, itemsByName, itemTagsApi, evaluation, showToast, showConfirmModal, showInputModal }) => {
    const { scopes, globalVariables, globalsCode, tags, saveData } = store;

    const selectedScopeId = ref(null);
    const scopeCodeEditorRef = ref(null);

    const selectedScope = computed(() => scopes.value.find(s => s.id === selectedScopeId.value));

    // Keep a scope selected whenever any exist (initial load, import, delete).
    watch(scopes, () => {
        if (!selectedScope.value) selectedScopeId.value = scopes.value[0]?.id ?? null;
    }, { immediate: true });

    // CRUD
    const createScope = () => {
        showInputModal('New Scope', '', (name) => {
            if (!name || !name.trim()) return;
            const scope = normalizeScope({ id: Date.now(), name: name.trim(), itemTagKeys: [], code: '' });
            scopes.value.push(scope);
            selectedScopeId.value = scope.id;
            saveData();
            showToast(`Scope "${scope.name}" created.`, 'success');
        });
    };

    const renameScope = () => {
        const scope = selectedScope.value;
        if (!scope) return;
        showInputModal('Rename Scope', scope.name, (name) => {
            if (!name || !name.trim()) return;
            scope.name = name.trim();
            saveData();
            showToast(`Scope renamed to "${scope.name}".`, 'success');
        });
    };

    const deleteScope = () => {
        const scope = selectedScope.value;
        if (!scope) return;
        showConfirmModal(
            'Delete Scope',
            `Are you sure you want to delete the scope "<strong>${scope.name}</strong>" and its code? Item tags aren't affected.`,
            () => {
                scopes.value = scopes.value.filter(s => s.id !== scope.id);
                saveData();
                showToast(`Scope "${scope.name}" deleted.`, 'success');
            }
        );
    };

    // Linked item tags
    const scopeItemTagKeys = computed({
        get: () => selectedScope.value?.itemTagKeys || [],
        set: (keys) => {
            if (!selectedScope.value) {
                return;
            }
            selectedScope.value.itemTagKeys = keys;
            saveData();
        },
    });

    // The items the scope's code looks up with getOsrsItem, once each.
    const scopeCodeItems = computed(() => {
        const catalog = itemTagsApi.itemCatalog.value;
        const found = new Map();
        for (const arg of itemArgsInCode(selectedScope.value?.code)) {
            const item = findItem(arg, catalog.byId, catalog.byName);
            if (item) {
                found.set(item.id, item);
            }
        }
        return [...found.values()];
    });

    // Every item the scope lists (by linked tag) or its code looks up, once, in that order.
    const scopeItemSources = computed(() => {
        const scope = selectedScope.value;
        if (!scope) {
            return [];
        }
        const byId = new Map();
        for (const key of scope.itemTagKeys.filter(itemTagsApi.isItemTag)) {
            for (const item of itemTagsApi.itemsWithTag(key)) {
                byId.set(item.id, item);
            }
        }
        for (const item of scopeCodeItems.value) {
            byId.set(item.id, item);
        }
        return [...byId.values()];
    });

    // Hues spread over the families the scope's items belong to (see allocateTagHues).
    const scopeTagHues = computed(() => allocateTagHues({
        seed: selectedScope.value?.colorSeed ?? 0,
        itemTagLists: scopeItemSources.value.map(item => itemTagsApi.itemColorTagsOf(item.id)),
        isFamilyTag: itemTagsApi.isFamilyTag,
    }));

    // Item colors. An item's color in a scope is the one picked by hand, else the automatic one.
    const itemColorIn = (scope, itemId) => {
        const picked = scope.itemColors[itemId];
        if (picked) {
            return picked;
        }
        return autoItemColor({
            seed: scope.colorSeed,
            itemId,
            tags: itemTagsApi.itemColorTagsOf(itemId),
            isFamilyTag: itemTagsApi.isFamilyTag,
            tagHues: scopeTagHues.value,
        });
    };

    // An item as a scope shows it: with its color and its own tags.
    const scopeItem = (scope, item) => ({
        ...item,
        color: itemColorIn(scope, item.id),
        tags: itemTagsApi.itemTagsOf(item.id),
    });

    // [{ key, label, items }] for each linked tag that exists, in the order they were linked.
    const scopeItemTagSections = computed(() => {
        const scope = selectedScope.value;
        if (!scope) {
            return [];
        }
        return scope.itemTagKeys
            .filter(itemTagsApi.isItemTag)
            .map(key => ({
                key,
                label: itemTagsApi.itemTagLabel(key),
                items: itemTagsApi.itemsWithTag(key).map(item => scopeItem(scope, item)),
            }));
    });

    // Every item the scope lists or its code looks up, with its color: what the editor tints
    // item refs with, and what auto-coloring variables blends.
    const scopeItems = computed(() => {
        const scope = selectedScope.value;
        if (!scope) {
            return [];
        }
        return scopeItemSources.value.map(item => scopeItem(scope, item));
    });

    // The color shown for an item anywhere on the Scopes tab (e.g. in item search results).
    const scopeItemColor = (itemId) => {
        if (!selectedScope.value) {
            return UNDECLARED_COLOR;
        }
        return itemColorIn(selectedScope.value, itemId);
    };

    const setScopeItemColor = (itemId, color) => {
        if (!selectedScope.value) {
            return;
        }
        selectedScope.value.itemColors[itemId] = color;
        saveData();
    };

    // A new palette: a new seed, and the hand-picked colors are dropped.
    const rerollScopeItemColors = () => {
        const scope = selectedScope.value;
        if (!scope) {
            return;
        }
        const pickedCount = Object.keys(scope.itemColors).length;
        const applyReroll = () => {
            scope.colorSeed = newItemColorSeed();
            scope.itemColors = {};
            saveData();
            showToast('New item colors.', 'success');
        };
        if (!pickedCount) {
            applyReroll();
            return;
        }
        showConfirmModal(
            'New Item Colors',
            `Give "<strong>${scope.name}</strong>" a new item palette? The <strong>${pickedCount}</strong> item color(s) picked by hand will be replaced too.`,
            applyReroll
        );
    };

    // Code
    const scopeCode = computed({
        get: () => selectedScope.value?.code ?? '',
        set: (code) => {
            if (selectedScope.value) selectedScope.value.code = code;
        },
    });

    const parsedScopeCode = computed(() => parseScopeCode(scopeCode.value));
    const scopeCodeErrors = computed(() => {
        const runError = selectedScope.value && evaluation.getScopeResult(selectedScope.value).error;
        return runError ? [...parsedScopeCode.value.errors, runError] : parsedScopeCode.value.errors;
    });

    // Derives scope.variables from parsed code; does nothing while the code has errors.
    const syncScopeVariables = (scope, result) => {
        if (!result.errors.length) scope.variables = mergeParsedVariables(scope.variables || [], result.variables);
    };

    // The code is always saved; the derived variables only update while it parses cleanly.
    const applyScopeCode = () => {
        const scope = selectedScope.value;
        if (!scope) return;
        syncScopeVariables(scope, parsedScopeCode.value);
        saveData();
    };

    // Rewrites legacy I_<id>_H/L refs once the item names are known. Runs when items load, data
    // is loaded/imported, or a scope is opened (covers scopes merged in by an import). Not on
    // every edit, so a half-typed I_12 isn't rewritten to the wrong item.
    const migrateLegacyRefs = () => {
        if (!itemsByName.value.size) return;
        let migratedCount = 0;

        // Globals first, so the scopes' new consts avoid any keys the globals gain.
        const migratedGlobals = migrateLegacyItemRefs(globalsCode.value, items.value);
        if (migratedGlobals !== globalsCode.value) {
            globalsCode.value = migratedGlobals;
            const result = parseScopeCode(migratedGlobals);
            if (!result.errors.length) globalVariables.value = mergeParsedVariables(globalVariables.value, result.variables);
            migratedCount++;
        }

        const globalKeys = globalVariables.value.map(v => v.key).filter(Boolean);
        scopes.value.forEach(scope => {
            const code = migrateLegacyItemRefs(scope.code, items.value, globalKeys);
            if (code === scope.code) return;
            scope.code = code;
            syncScopeVariables(scope, parseScopeCode(code));
            migratedCount++;
        });

        if (migratedCount) {
            saveData();
            showToast(`Updated ${migratedCount} scope(s) to getOsrsItem('Name') price refs.`, 'success');
        }
    };

    watch([itemsByName, scopes, selectedScope], migrateLegacyRefs);

    const onScopeCodeInput = () => applyScopeCode();

    // Tags typed in code are registered on blur rather than per keystroke, so half-typed
    // tag names don't end up in the tag list.
    const registerVariableTags = (variables) => {
        if (addMissingTags(tags.value, variables)) saveData();
    };

    const onScopeCodeBlur = () => registerVariableTags(selectedScope.value?.variables);

    const insertIntoScopeCode = (text) => {
        if (!selectedScope.value) return;
        insertIntoCodeEditor(scopeCodeEditorRef, scopeCode, text);
        applyScopeCode();
    };

    // Variable colors, set from the editors' hover picker. A "// @color: #rrggbb" line in the
    // code takes precedence over a color set here.
    const findVariable = (variables, key) => (variables || []).find(v => v.key === key);

    const setGlobalVariableColor = (key, color) => {
        const variable = findVariable(globalVariables.value, key);
        if (!variable) return;
        variable.color = color;
        saveData();
    };

    // A scope's own variable shadows a global with the same key.
    const setScopeVariableColor = (key, color) => {
        const variable = findVariable(selectedScope.value?.variables, key) || findVariable(globalVariables.value, key);
        if (!variable) return;
        variable.color = color;
        saveData();
    };

    // Recolors the scope's variables from the colors of what they read (see autoVariableColors).
    const autoColorScopeVariables = () => {
        const scope = selectedScope.value;
        if (!scope) return;
        if (parsedScopeCode.value.errors.length) {
            showToast('Fix the code errors before auto-coloring.', 'error');
            return;
        }
        const lockedKeys = new Set(parsedScopeCode.value.variables.filter(v => v.color).map(v => v.key));
        const changes = autoVariableColors(scope.variables || [], {
            globals: globalVariables.value,
            items: scopeItems.value,
            lockedKeys,
        });
        const count = Object.keys(changes).length;
        if (!count) {
            showToast('No colors to change: no variable reads another variable or a colored item.', 'info');
            return;
        }
        showConfirmModal(
            'Auto-color Variables',
            `Recolor <strong>${count}</strong> variable(s) in "<strong>${scope.name}</strong>" to match the variables and items they're calculated from? Their current colors will be replaced.`,
            () => {
                (scope.variables || []).forEach(v => {
                    if (changes[v.key]) v.color = changes[v.key];
                });
                saveData();
                showToast(`Recolored ${count} variable(s).`, 'success');
            }
        );
    };

    // The globals a scope can see: the public ones, plus keys the globals' code returns without
    // declaring them (as { key, returned: true }).
    const visibleGlobalVariables = computed(() => [
        ...globalVariables.value.filter(v => evaluation.isGlobalPublic(v.key)),
        ...returnedOnlyKeys(evaluation.globalsResult.value, globalVariables.value)
            .map(key => ({ key, name: 'Returned', color: UNDECLARED_COLOR, returned: true })),
    ]);

    // Every key visible to this scope's code, with the value it ends up holding.
    const scopeValues = computed(() => {
        const scope = selectedScope.value;
        if (!scope) return { locals: [], globals: [] };
        const locals = [
            ...(scope.variables || []).map(v => ({
                key: v.key, name: v.name, color: v.color, value: evaluation.getScopeValue(scope, v.key),
                private: !evaluation.isScopeKeyPublic(scope, v.key),
            })),
            ...returnedOnlyKeys(evaluation.getScopeResult(scope), scope.variables).map(key => ({
                key, name: 'Returned', color: UNDECLARED_COLOR, value: evaluation.getScopeValue(scope, key), private: false,
            })),
        ];
        const localKeys = new Set(locals.map(v => v.key));
        const globals = visibleGlobalVariables.value.map(v => ({
            key: v.key, name: v.name, color: v.color, value: evaluation.getGlobalValue(v.key),
            overridden: localKeys.has(v.key), variable: v,
        }));
        return { locals, globals };
    });

    const impliedScopeCode = computed(() => generateImpliedCode(
        scopeValues.value.globals.map(g => ({ variable: g.variable, value: g.value, overridden: g.overridden }))
    ));

    return {
        selectedScopeId, selectedScope, createScope, renameScope, deleteScope,
        scopeItemTagKeys, scopeItemTagSections, scopeItems, scopeItemColor, setScopeItemColor, rerollScopeItemColors,
        scopeCode, scopeCodeErrors, scopeCodeEditorRef, scopeValues, impliedScopeCode, visibleGlobalVariables,
        onScopeCodeInput, onScopeCodeBlur, insertIntoScopeCode, registerVariableTags, isErrorValue,
        setGlobalVariableColor, setScopeVariableColor, autoColorScopeVariables,
    };
};
