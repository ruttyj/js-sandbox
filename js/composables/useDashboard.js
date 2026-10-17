// Dashboard: every public variable (scope and global) carrying the selected tags, grouped by tag.
// Variables left out of their code's `return { ... }` are private and not listed.
const DASHBOARD_FILTER_KEY = 'osrs-ge-tracker-dashboard-filter';

const useDashboard = ({ store, evaluation, getVariableValue, getGlobalVariableValue }) => {
    const { scopes, globalVariables, tags } = store;
    const dashboardFilterTags = ref([]);

    const loadDashboardFilter = () => {
        const stored = localStorage.getItem(DASHBOARD_FILTER_KEY);
        if (!stored) return;
        try {
            dashboardFilterTags.value = JSON.parse(stored);
        } catch (e) { console.error(e); }
    };

    watch(dashboardFilterTags, () => {
        localStorage.setItem(DASHBOARD_FILTER_KEY, JSON.stringify(dashboardFilterTags.value));
    }, { deep: true });

    const tagLabel = (key) => tags.value.find(t => t.key === key)?.label || key;

    const allUsedTags = computed(() => {
        const t = new Set();
        const allVars = [...scopes.value.flatMap(s => s.variables || []), ...globalVariables.value];
        allVars.forEach(v => {
            if (Array.isArray(v.tags)) v.tags.forEach(tag => t.add(tag));
        });
        return Array.from(t).sort();
    });

    const dashboardTagOptions = computed(() => allUsedTags.value.map(key => ({ key, label: tagLabel(key) })));

    const hasTag = (variable, tagKey) => Array.isArray(variable.tags) && variable.tags.includes(tagKey);

    // Non-numeric values count as 0 for sorting and totals.
    const numericValue = (variable) => Number(variable.value) || 0;

    // Every public variable carrying tagKey, scopes' first, each with its value and where it's from.
    const variablesWithTag = (tagKey) => [
        ...scopes.value.flatMap(scope => (scope.variables || []).flatMap((v, i) =>
            (hasTag(v, tagKey) && evaluation.isScopeKeyPublic(scope, v.key)
                ? [{ ...v, scopeName: scope.name, value: getVariableValue(i, scope) }]
                : []))),
        ...globalVariables.value.flatMap((v, i) =>
            (hasTag(v, tagKey) && evaluation.isGlobalPublic(v.key)
                ? [{ ...v, scopeName: 'Global', value: getGlobalVariableValue(i) }]
                : [])),
    ];

    // One dashboard section: the tag's variables, largest value first, and their total.
    const tagSection = (tagKey, variables) => {
        const sorted = [...variables].sort((a, b) => numericValue(b) - numericValue(a));
        return {
            tagKey,
            tagLabel: tagLabel(tagKey),
            variables: sorted,
            total: sorted.reduce((sum, v) => sum + numericValue(v), 0),
        };
    };

    // [{ tagKey, tagLabel, variables, total }] per selected tag, skipping tags with no variables.
    const dashboardGroupedVariables = computed(() => dashboardFilterTags.value
        .map(tagKey => ({ tagKey, variables: variablesWithTag(tagKey) }))
        .filter(({ variables }) => variables.length > 0)
        .map(({ tagKey, variables }) => tagSection(tagKey, variables)));

    return { dashboardFilterTags, allUsedTags, dashboardTagOptions, dashboardGroupedVariables, loadDashboardFilter };
};
