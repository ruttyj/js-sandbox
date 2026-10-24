// Mirrors the selected item tag, selected scope and active tab into ?itemTag=&scope=&tab= so views
// are linkable and a refresh reopens the same view.
const VALID_TABS = ['market', 'item-tags', 'globals', 'scopes', 'tags', 'dashboard'];
const LEGACY_TABS = { recipes: 'scopes', 'group-items': 'item-tags' };

const setUrlParam = (url, key, value) => {
    const hasValue = value !== null && value !== undefined && value !== '';
    if (hasValue) {
        url.searchParams.set(key, value);
    } else {
        url.searchParams.delete(key);
    }
};

// The view the page was opened with: { itemTag, scope, tab }, each null when absent.
const readUrlState = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const tab = urlParams.get('tab');
    return {
        itemTag: urlParams.get('itemTag'),
        scope: urlParams.get('scope'),
        tab: LEGACY_TABS[tab] || tab,
    };
};

const useUrlState = ({ isItemTag, scopes, selectedItemTagKey, selectedScopeId, activeTab }) => {
    // Read before anything loads: loading data selects the first scope, and writing that to the
    // URL first would replace the view being restored.
    const initialState = readUrlState();
    let isRestored = false;

    const updateUrlParams = () => {
        if (!isRestored) {
            return;
        }
        const url = new URL(window.location);
        url.searchParams.delete('group');
        setUrlParam(url, 'itemTag', selectedItemTagKey.value);
        setUrlParam(url, 'scope', selectedScopeId.value);
        setUrlParam(url, 'tab', activeTab.value);
        window.history.replaceState(null, '', url);
    };

    // Call after the saved data is loaded so scope ids and item tags can be resolved. Until then
    // the URL is left alone, so a failed load keeps the link intact.
    const initFromUrl = () => {
        const { itemTag, scope, tab } = initialState;

        if (itemTag && isItemTag(itemTag)) {
            selectedItemTagKey.value = itemTag;
        }
        if (scope) {
            const targetScope = scopes.value.find(s => String(s.id) === scope);
            if (targetScope) {
                selectedScopeId.value = targetScope.id;
            }
        }
        if (tab && VALID_TABS.includes(tab)) {
            activeTab.value = tab;
        }

        isRestored = true;
        updateUrlParams();
    };

    watch([activeTab, selectedItemTagKey, selectedScopeId], updateUrlParams);

    return { initFromUrl };
};
