// Variable evaluation, the Global Vars tab, and item-ref insertion/copying.
// Globals are edited as one block of code (stored as `globalsCode`), the same way a scope's
// code is; see useScopes.
const useVariables = ({ store, items, evaluation, selectedScope, scopesApi, showToast }) => {
    const { globalVariables, globalsCode, saveData } = store;

    // Evaluation (see useEvaluation)
    const getVariableValue = (index, scope = selectedScope.value) => {
        const variable = scope && scope.variables && scope.variables[index];
        return variable ? evaluation.getScopeValue(scope, variable.key) : "";
    };

    // Globals run without a scope, so they can't reference a scope's own keys.
    const getGlobalVariableValue = (index) => {
        const variable = globalVariables.value && globalVariables.value[index];
        return variable ? evaluation.getGlobalValue(variable.key) : "";
    };

    // Current values by key, for the code editors' hover tooltips. The scope editor also lists
    // the globals, so a key that isn't one of the scope's own reads the global value.
    const scopeCodeValueOf = (key) => {
        const scope = selectedScope.value;
        const isScopeKey = (scope?.variables || []).some(v => v.key === key);
        if (isScopeKey) {
            return evaluation.getScopeValue(scope, key);
        }
        return evaluation.getGlobalValue(key);
    };

    const globalsCodeValueOf = (key) => evaluation.getGlobalValue(key);

    // Global variables, as code
    const parsedGlobalsCode = computed(() => parseScopeCode(globalsCode.value));
    const globalsCodeErrors = computed(() => {
        const runError = evaluation.globalsResult.value.error;
        return runError ? [...parsedGlobalsCode.value.errors, runError] : parsedGlobalsCode.value.errors;
    });

    // The code is always saved; the derived variables only update while it parses cleanly.
    const applyGlobalsCode = () => {
        const result = parsedGlobalsCode.value;
        if (!result.errors.length) globalVariables.value = mergeParsedVariables(globalVariables.value, result.variables);
        saveData();
    };

    const onGlobalsCodeInput = () => applyGlobalsCode();
    const onGlobalsCodeBlur = () => scopesApi.registerVariableTags(globalVariables.value);

    const globalValues = computed(() => [
        ...globalVariables.value.map(v => ({
            key: v.key, name: v.name, color: v.color, value: evaluation.getGlobalValue(v.key),
            private: !evaluation.isGlobalPublic(v.key),
        })),
        ...returnedOnlyKeys(evaluation.globalsResult.value, globalVariables.value).map(key => ({
            key, name: 'Returned', color: UNDECLARED_COLOR, value: evaluation.getGlobalValue(key), private: false,
        })),
    ]);

    // Item refs (the item list only appears on the Scopes tab)
    // Inserts getOsrsItem('Name').highPrice/lowPrice at the caret of the scope code editor.
    const insertPriceRef = (itemId, type) => {
        const item = items.value[itemId];
        if (item) scopesApi.insertIntoScopeCode(buildItemRef(item, type));
    };

    // Item lookup on the Scopes tab: any GE item by name or ID. Best matches first (exact ID or
    // name, then names starting with the text, then containing it); items in the scope's groups
    // keep their color.
    const ITEM_LOOKUP_LIMIT = 25;
    const itemLookupText = ref('');

    const itemLookupMatches = computed(() => {
        const query = itemLookupText.value.trim().toLowerCase();
        if (!query) return [];
        const isId = /^\d+$/.test(query);
        const rank = (item) => {
            const name = item.name.toLowerCase();
            const id = String(item.id);
            if (isId && id === query) return 0;
            if (name === query) return 1;
            if (name.startsWith(query)) return 2;
            if (isId && id.startsWith(query)) return 3;
            if (name.includes(query)) return 4;
            return -1;
        };
        return Object.values(items.value)
            .map(item => ({ item, rank: rank(item) }))
            .filter(m => m.rank >= 0)
            .sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name))
            .map(m => m.item);
    });

    const itemLookupResults = computed(() => {
        const groupColors = new Map(scopesApi.scopeItems.value.map(item => [String(item.id), item.color]));
        return itemLookupMatches.value.slice(0, ITEM_LOOKUP_LIMIT)
            .map(item => ({ ...item, color: groupColors.get(String(item.id)) || UNDECLARED_COLOR }));
    });

    const itemLookupTotal = computed(() => itemLookupMatches.value.length);

    const copyToClipboard = async (text) => {
        try {
            await navigator.clipboard.writeText(text);
            showToast(`Copied ${text}`, 'success');
        } catch (e) {
            showToast('Could not copy to the clipboard.', 'error');
        }
    };

    return {
        getVariableValue, getGlobalVariableValue, scopeCodeValueOf, globalsCodeValueOf,
        globalsCodeErrors, globalValues, onGlobalsCodeInput, onGlobalsCodeBlur,
        insertPriceRef, copyToClipboard, itemLookupText, itemLookupResults, itemLookupTotal,
    };
};
