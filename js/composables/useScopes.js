// Scopes tab: a scope is one block of code (stored on `scope.code`) that runs live, top to
// bottom; its top-level declarations are its variables. A scope can reference item groups; they're listed as a short list of items to draw
// from, but don't limit the code (getOsrsItem reaches any item). The Global Vars tab edits the
// globals the same way (see useVariables) and reuses registerVariableTags.

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

const useScopes = ({ store, items, itemsByName, evaluation, showToast, showConfirmModal, showInputModal }) => {
    const { groups, scopes, globalVariables, globalsCode, tags, saveData } = store;

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
            const scope = normalizeScope({ id: Date.now(), name: name.trim(), groupIds: [], code: '' });
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
            `Are you sure you want to delete the scope "<strong>${scope.name}</strong>" and its code? Its item groups are kept.`,
            () => {
                scopes.value = scopes.value.filter(s => s.id !== scope.id);
                saveData();
                showToast(`Scope "${scope.name}" deleted.`, 'success');
            }
        );
    };

    // Referenced item groups
    const scopeGroupOptions = computed(() => groups.value.map(g => ({ key: String(g.id), label: g.name })));

    const scopeGroupIds = computed({
        get: () => selectedScope.value?.groupIds || [],
        set: (ids) => {
            if (!selectedScope.value) return;
            selectedScope.value.groupIds = ids;
            saveData();
        },
    });

    // [{ group, items }] for each referenced group that still exists, in reference order.
    const scopeItemGroups = computed(() => {
        const byId = new Map(groups.value.map(g => [String(g.id), g]));
        return scopeGroupIds.value
            .map(id => byId.get(id))
            .filter(Boolean)
            .map(group => ({ group, items: hydrateGroupItems(group.items, items.value) }));
    });

    // Every referenced item once, for highlighting refs in the editor with the item's color.
    const scopeItems = computed(() => {
        const seen = new Set();
        return scopeItemGroups.value.flatMap(g => g.items).filter(item => !seen.has(item.id) && seen.add(item.id));
    });

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
        scopeGroupOptions, scopeGroupIds, scopeItemGroups, scopeItems,
        scopeCode, scopeCodeErrors, scopeCodeEditorRef, scopeValues, impliedScopeCode, visibleGlobalVariables,
        onScopeCodeInput, onScopeCodeBlur, insertIntoScopeCode, registerVariableTags, isErrorValue,
        setGlobalVariableColor, setScopeVariableColor, autoColorScopeVariables,
    };
};
