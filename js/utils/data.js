// Shared shape helpers for groups, items and variables, used by load, import and reorder.

// Returns a new array with the element at `from` moved to `to`.
const moveItem = (array, from, to) => {
    const copy = [...array];
    const [removed] = copy.splice(from, 1);
    copy.splice(to, 0, removed);
    return copy;
};

// Accepts legacy comma-separated strings; always returns an array of upper-case keys.
const normalizeTags = (tags) => {
    if (typeof tags === 'string') {
        tags = tags.split(',').map(s => s.trim()).filter(s => s);
    }
    if (!Array.isArray(tags)) return [];
    return tags.map(t => t.toUpperCase());
};

// Adds a { key, label } entry to tagList for every tag the variables use that it lacks.
// Returns whether any were added.
const addMissingTags = (tagList, variables) => {
    const known = new Set(tagList.map(t => t.key));
    let added = false;
    (variables || []).forEach(v => v.tags.forEach(tag => {
        if (known.has(tag)) return;
        tagList.push({ key: tag, label: tag });
        known.add(tag);
        added = true;
    }));
    return added;
};

const normalizeVariable = (variable) => {
    if (!variable.color) variable.color = getRandomVibrantColor();
    variable.tags = normalizeTags(variable.tags);
    return variable;
};

// Groups only persist id/color/order per item; names and prices come from the live item map.
const normalizeGroupItems = (items) => items.map((item, index) => ({
    id: item.id,
    color: item.color || getRandomVibrantColor(),
    order: item.order !== undefined ? item.order : index
}));

// Stored group items only hold id/color/order; merge in live name, icon and prices.
// items: { [id]: item }
const hydrateGroupItems = (groupItems, items) => groupItems.map(item => {
    const globalItem = items[item.id];
    return globalItem
        ? { ...globalItem, ...item }
        : { ...item, name: 'Loading...', highPrice: 0, lowPrice: 0 };
});

// A group is a named list of items. Scopes reference groups by id (as strings).
const normalizeGroup = (group) => {
    group.items = normalizeGroupItems(group.items || []);
    return group;
};

// A scope is a block of code (the source of truth) plus the variables parsed from it and the
// ids of the item groups it lists for reference. Referenced groups don't limit what the code
// can use; any item is reachable through getOsrsItem.
const normalizeScope = (scope) => {
    scope.groupIds = (scope.groupIds || []).map(String);
    scope.variables = (scope.variables || []).map(normalizeVariable);
    if (typeof scope.code !== 'string') scope.code = generateScopeCode(scope);
    return scope;
};

// Before scopes existed, each group carried its own recipes (code/variables). Moves any
// non-empty recipes into a scope of the same name that references the group, and strips them
// from the group. Returns the new scopes.
const extractLegacyScopes = (groups) => {
    const scopes = [];
    groups.forEach(group => {
        const variables = group.variables || [];
        const code = typeof group.code === 'string' ? group.code : generateScopeCode({ variables });
        if (code.trim() || variables.length) {
            scopes.push(normalizeScope({ id: group.id, name: group.name, groupIds: [group.id], code, variables }));
        }
        delete group.code;
        delete group.variables;
    });
    return scopes;
};
