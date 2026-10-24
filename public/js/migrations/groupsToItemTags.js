// MIGRATION: item groups -> user item tags, for importing files exported by older versions (the
// call site in useImportExport is marked "groupsToItemTags migration"). Saved data no longer
// needs it: it lives on the server, which only ever held the current format.
//
// Each group becomes a user item tag with the group's name, listing the group's items. A scope's
// referenced groups become its linked item tags, and the colors the group items had become the
// scope's item colors, so nothing on screen changes color.
//
// It also converts data saved by the first item-tags version, which kept per-item changes as
// itemTagEdits { [itemId]: { add, remove } } and let user entries relabel system tags: additions
// move into their user tag's items; removals and relabels are dropped (system tags are now
// read-only).

const systemTagKeys = () => new Set(BUILTIN_ITEM_TAG_DATA.tags.map(tag => tag.key));

// The user tag with this label, or a new one. Same-named groups (e.g. from an import) share one
// tag; a name that slugifies to a system key gets a key of its own ("rune" -> "rune-2").
const userTagForLabel = (data, label) => {
    const existing = data.itemTags.find(tag => tag.label === label);
    if (existing) {
        return existing;
    }
    const taken = new Set([...systemTagKeys(), ...data.itemTags.map(tag => tag.key)]);
    const tag = { key: uniqueItemTagKey(slugifyItemTagKey(label), taken), label, parent: null, items: [] };
    data.itemTags.push(tag);
    return tag;
};

const addItemsToUserTag = (tag, itemIds) => {
    for (const itemId of itemIds.map(Number)) {
        if (!tag.items.includes(itemId)) {
            tag.items.push(itemId);
        }
    }
};

// itemTagEdits (first item-tags version) -> items on user tags. Items added to a system tag go
// to a user tag of their own (labelled as the user had relabelled it), and scopes that linked
// that system tag link the new user tag instead, since that's the tag they meant.
const migrateItemTagEdits = (data, edits) => {
    const systemKeys = systemTagKeys();

    // Entries that only relabelled a system tag are dropped.
    const relabels = data.itemTags.filter(tag => systemKeys.has(tag.key));
    data.itemTags = data.itemTags.filter(tag => !systemKeys.has(tag.key));

    const movedKeys = new Map(); // system key -> the user tag key its additions moved to
    for (const [itemId, edit] of Object.entries(edits || {})) {
        for (const key of edit.add || []) {
            let tag = data.itemTags.find(t => t.key === (movedKeys.get(key) || key));
            if (!tag) {
                const relabel = relabels.find(t => t.key === key);
                tag = userTagForLabel(data, relabel ? relabel.label : key);
                if (systemKeys.has(key)) {
                    movedKeys.set(key, tag.key);
                }
            }
            addItemsToUserTag(tag, [itemId]);
        }
    }

    for (const scope of data.scopes) {
        scope.itemTagKeys = (scope.itemTagKeys || []).map(key => movedKeys.get(key) || key);
    }
};

// A scope's groupIds -> itemTagKeys, and its groups' item colors -> scope.itemColors (the first
// group listing an item wins, as it did when the scope was shown).
const migrateScopeGroups = (scope, groupsById, keysByGroupId) => {
    const groupIds = (scope.groupIds || []).map(String);
    scope.itemTagKeys = scope.itemTagKeys || [];
    scope.itemColors = scope.itemColors || {};

    for (const groupId of groupIds) {
        const key = keysByGroupId.get(groupId);
        const group = groupsById.get(groupId);
        if (!key || !group) {
            continue;
        }
        if (!scope.itemTagKeys.includes(key)) {
            scope.itemTagKeys.push(key);
        }
        for (const item of group.items || []) {
            if (item.color && !scope.itemColors[item.id]) {
                scope.itemColors[item.id] = item.color;
            }
        }
    }
    delete scope.groupIds;
};

/**
 * Brings saved or imported data up to the user-tag shape, in place.
 * @param {{ groups?: Object[], scopes: Object[], itemTags: Object[], itemTagEdits?: Object }} data
 *     As loaded or imported; itemTags already normalized.
 * @returns {number} How many groups and per-item edits were migrated (0 when there were none).
 */
const migrateGroupsToItemTags = (data) => {
    const edits = data.itemTagEdits || {};
    const editCount = Object.keys(edits).length;
    migrateItemTagEdits(data, edits);
    delete data.itemTagEdits;

    const groups = Array.isArray(data.groups) ? data.groups : [];
    const groupsById = new Map(groups.map(group => [String(group.id), group]));
    const keysByGroupId = new Map();

    for (const group of groups) {
        const tag = userTagForLabel(data, group.name);
        addItemsToUserTag(tag, (group.items || []).map(item => item.id));
        keysByGroupId.set(String(group.id), tag.key);
    }

    for (const scope of data.scopes) {
        migrateScopeGroups(scope, groupsById, keysByGroupId);
    }

    delete data.groups;
    return groups.length + editCount;
};
