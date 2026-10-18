// Mirrors the selected item tag, selected scope and active tab into ?itemTag=&scope=&tab= so views
// are linkable.
const VALID_TABS = ['market', 'item-tags', 'globals', 'scopes', 'tags', 'dashboard'];
const LEGACY_TABS = { recipes: 'scopes', 'group-items': 'item-tags' };

const useUrlState = ({ isItemTag, scopes, selectedItemTagKey, selectedScopeId, activeTab }) => {
    const setParam = (url, key, value) => {
        if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, value);
        else url.searchParams.delete(key);
    };

    const updateUrlParams = () => {
        const url = new URL(window.location);
        url.searchParams.delete('group');
        setParam(url, 'itemTag', selectedItemTagKey.value);
        setParam(url, 'scope', selectedScopeId.value);
        setParam(url, 'tab', activeTab.value);
        window.history.replaceState(null, '', url);
    };

    // Call after the saved data is loaded so scope ids and item tags can be resolved.
    const initFromUrl = () => {
        const urlParams = new URLSearchParams(window.location.search);
        const itemTagParam = urlParams.get('itemTag');
        const scopeIdParam = urlParams.get('scope');
        const tabParam = LEGACY_TABS[urlParams.get('tab')] || urlParams.get('tab');

        if (itemTagParam && isItemTag(itemTagParam)) {
            selectedItemTagKey.value = itemTagParam;
        }
        if (scopeIdParam) {
            const targetScope = scopes.value.find(s => String(s.id) === scopeIdParam);
            if (targetScope) selectedScopeId.value = targetScope.id;
        }
        if (tabParam && VALID_TABS.includes(tabParam)) {
            activeTab.value = tabParam;
        }
    };

    watch([activeTab, selectedItemTagKey, selectedScopeId], updateUrlParams);

    return { initFromUrl };
};
