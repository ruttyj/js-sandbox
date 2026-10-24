// Variable evaluation, the Global Vars tab, and item-ref insertion/copying.
// Globals are edited as one block of code (stored as `globalsCode`), the same way a scope's
// code is; see useScopes.
const useVariables = ({ store, items, itemTagsApi, evaluation, selectedScope, scopesApi, showToast }) => {
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

    // The panels the globals' ui calls made, and the run error (see ScopeUiPanel).
    const globalsUiPanels = computed(() => evaluation.globalsResult.value.ui);
    const globalsRunError = computed(() => evaluation.globalsResult.value.error);
    const globalsUiInputs = uiInputsFor(UI_INPUTS_GLOBALS);

    const globalsCodeEditorRef = ref(null);
    const insertSnippetIntoGlobalsCode = (snippet) => {
        insertSnippetIntoCodeEditor(globalsCodeEditorRef, globalsCode, snippet);
        applyGlobalsCode();
    };
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

    // Item lookup on the Scopes tab: any GE item by name or ID, narrowed by item tags written as
    // "tag:<key>" (see parseItemSearch). Items show in the scope's colors with their tags.
    const ITEM_LOOKUP_LIMIT = 50;
    const itemLookupText = ref('');

    const itemLookupSearch = computed(() => parseItemSearch(itemLookupText.value));

    // Tags in the search that don't exist, so the panel can say why nothing matched.
    const itemLookupUnknownTags = computed(() => itemLookupSearch.value.tags.filter(key => !itemTagsApi.isItemTag(key)));

    const itemLookupMatches = computed(() => {
        const search = itemLookupSearch.value;
        const isEmpty = !search.text && !search.tags.length;
        if (isEmpty || itemLookupUnknownTags.value.length) {
            return [];
        }
        const candidates = Object.values(items.value)
            .filter(item => search.tags.every(key => itemTagsApi.hasItemTag(item.id, key)));
        return rankItemsByText(candidates, search.text);
    });

    const itemLookupResults = computed(() => itemLookupMatches.value.slice(0, ITEM_LOOKUP_LIMIT).map(item => ({
        ...item,
        color: scopesApi.scopeItemColor(item.id),
        tags: itemTagsApi.itemTagsOf(item.id),
    })));

    const itemLookupTotal = computed(() => itemLookupMatches.value.length);

    // Clicking a tag chip searches for that tag.
    const searchItemTag = (key) => {
        itemLookupText.value = `tag:${key} `;
    };

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
        globalsCodeEditorRef, insertSnippetIntoGlobalsCode, globalsUiPanels, globalsRunError, globalsUiInputs,
        insertPriceRef, copyToClipboard, itemLookupText, itemLookupResults, itemLookupTotal,
        itemLookupUnknownTags, searchItemTag,
    };
};
