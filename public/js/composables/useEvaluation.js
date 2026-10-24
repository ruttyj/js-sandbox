// Runs the globals' code and each scope's code (see runScopeCode), caching each result until its
// code, the prices it read or the globals change. Every scope run gets its own fresh run of the
// globals, so a scope that mutates a global object or array can't affect another scope.
// Code that returns an object only exposes the returned keys (see runScopeCode): scopes only see
// the public globals, and the Dashboard only lists public variables.
// A scope can also read another scope's public values with importScope('Name'); that scope runs
// (or reuses its cached result) first. Circular imports are an error.
// itemQuerySource: what queryOsrsItems() searches, with item tags (see useItemTags).
const useEvaluation = ({ store, items, itemsByName, itemQuerySource }) => {
    const { globalsCode, scopes } = store;

    const declaredKeys = (code) => parseScopeCode(code).variables.map(v => v.key);

    const runGlobals = () => runScopeCode(globalsCode.value, declaredKeys(globalsCode.value), {
        items: items.value, itemsByName: itemsByName.value, itemQuerySource,
        inputs: uiInputsFor(UI_INPUTS_GLOBALS),
    });

    const globalsResult = computed(runGlobals);

    // The scopes currently running, outermost first: an import of one of them is circular.
    const runningScopes = [];

    // Copies, so an importing scope that changes an object or array can't affect the scope it came from.
    const copyValue = (value) => {
        try {
            return structuredClone(value);
        } catch (e) {
            return value; // e.g. a function
        }
    };

    const importScope = (name) => {
        const wanted = String(name).trim().toLowerCase();
        const target = scopes.value.find(s => s.name.trim().toLowerCase() === wanted);
        if (!target) throw new Error(`Unknown scope "${name}"`);
        if (runningScopes.includes(target)) {
            throw new Error(`Circular import: ${[...runningScopes, target].map(s => s.name).join(' → ')}`);
        }
        const result = getScopeResult(target);
        if (result.error) throw new Error(`Scope "${target.name}" has an error: ${result.error}`);
        const values = {};
        exportedValues(result).forEach((value, key) => { values[key] = copyValue(value); });
        return Object.freeze(values);
    };

    // One computed per scope object, created on first use.
    const scopeResults = new WeakMap();
    const getScopeResult = (scope) => {
        if (!scopeResults.has(scope)) {
            scopeResults.set(scope, computed(() => {
                runningScopes.push(scope);
                try {
                    return runScopeCode(scope.code, declaredKeys(scope.code), {
                        items: items.value, itemsByName: itemsByName.value, itemQuerySource,
                        globals: exportedValues(runGlobals()), importScope,
                        inputs: uiInputsFor(scope.id),
                    });
                } finally {
                    runningScopes.pop();
                }
            }));
        }
        return scopeResults.get(scope).value;
    };

    /**
     * Runs code that isn't saved anywhere (a draft from the Claude chat) the way the globals' or a
     * scope's code runs: a scope draft sees the globals and can import scopes. Nothing is cached.
     * @param {string} code
     * @param {{ asGlobals: boolean, scope: Object|null }} options  scope: whose ui inputs it
     *     reads; null for none.
     * @returns {RunResult}
     */
    const runDraft = (code, { asGlobals, scope }) => {
        if (asGlobals) {
            return runScopeCode(code, declaredKeys(code), {
                items: items.value, itemsByName: itemsByName.value, itemQuerySource,
                inputs: uiInputsFor(UI_INPUTS_GLOBALS),
            });
        }
        return runScopeCode(code, declaredKeys(code), {
            items: items.value, itemsByName: itemsByName.value, itemQuerySource,
            globals: exportedValues(runGlobals()), importScope,
            inputs: scope ? uiInputsFor(scope.id) : null,
        });
    };

    // '' for a key the last run didn't declare (e.g. the code changed and has errors).
    const valueOf = (result, key) => (result.values.has(key) ? result.values.get(key) : '');

    const getGlobalValue = (key) => valueOf(globalsResult.value, key);
    const getScopeValue = (scope, key) => valueOf(getScopeResult(scope), key);

    const isGlobalPublic = (key) => isExported(globalsResult.value, key);
    const isScopeKeyPublic = (scope, key) => isExported(getScopeResult(scope), key);

    return { globalsResult, getScopeResult, getGlobalValue, getScopeValue, isGlobalPublic, isScopeKeyPublic, runDraft };
};
