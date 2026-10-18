// Shared shape helpers for scopes and variables, used by load and import.

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

// A scope is a block of code (the source of truth) plus the variables parsed from it, the item
// tags whose items it lists for reference (they don't limit the code: getOsrsItem reaches any
// item), and its item colors: itemColors { [itemId]: color } holds the ones picked by hand, and
// colorSeed seeds the automatic ones (see itemColors.js).
// Scopes saved before item tags have groupIds instead; the groupsToItemTags migration converts them.
const normalizeScope = (scope) => {
    scope.itemTagKeys = (scope.itemTagKeys || []).map(String);
    const hasItemColors = scope.itemColors && typeof scope.itemColors === 'object';
    scope.itemColors = hasItemColors ? scope.itemColors : {};
    if (scope.colorSeed === undefined) {
        scope.colorSeed = newItemColorSeed();
    }
    scope.variables = (scope.variables || []).map(normalizeVariable);
    if (typeof scope.code !== 'string') scope.code = generateScopeCode(scope);
    return scope;
};

// Before scopes existed, each item group carried its own recipes (code/variables). Moves any
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
