// Mirrors the selected group, selected scope and active tab into ?group=&scope=&tab= so views
// are linkable.
const VALID_TABS = ['market', 'group-items', 'globals', 'scopes', 'tags', 'dashboard'];
const LEGACY_TABS = { recipes: 'scopes' };

const useUrlState = ({ groups, scopes, selectedGroupId, selectedScopeId, activeTab }) => {
    const setParam = (url, key, value) => {
        if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, value);
        else url.searchParams.delete(key);
    };

    const updateUrlParams = () => {
        const url = new URL(window.location);
        setParam(url, 'group', selectedGroupId.value);
        setParam(url, 'scope', selectedScopeId.value);
        setParam(url, 'tab', activeTab.value);
        window.history.replaceState(null, '', url);
    };

    // Call after groups and scopes are loaded so their ids can be resolved.
    const initFromUrl = () => {
        const urlParams = new URLSearchParams(window.location.search);
        const groupIdParam = urlParams.get('group');
        const scopeIdParam = urlParams.get('scope');
        const tabParam = LEGACY_TABS[urlParams.get('tab')] || urlParams.get('tab');

        if (groupIdParam) {
            const targetGroup = groups.value.find(g => String(g.id) === groupIdParam);
            if (targetGroup) selectedGroupId.value = targetGroup.id;
        }
        if (scopeIdParam) {
            const targetScope = scopes.value.find(s => String(s.id) === scopeIdParam);
            if (targetScope) selectedScopeId.value = targetScope.id;
        }
        if (tabParam && VALID_TABS.includes(tabParam)) {
            activeTab.value = tabParam;
        }
    };

    watch([activeTab, selectedGroupId, selectedScopeId], updateUrlParams);

    return { initFromUrl };
};
