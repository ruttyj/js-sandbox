// Item tags (see utils/itemTags.js): system tags (read-only, shipped with the app) and the
// user's own tags (store.itemTags), which items have which tags, editing user tags (single and
// bulk, with confirm + undo for anything that untags), and the state of the Item Tags and Market
// tabs. Also builds the item catalog the editors use and the source queryOsrsItems() searches.
const useItemTags = ({ store, items, itemsByName, showToast, showUndoToast, showConfirmModal, showInputModal }) => {
    const { itemTags, scopes, saveData } = store;
    const system = BUILTIN_ITEM_TAG_DATA;

    // --- Reading tags ---------------------------------------------------------------------------

    const tagDefs = computed(() => buildItemTagDefs(system.tags, itemTags.value));

    // Each tag's lineage (itself, then its ancestors), worked out once per change to the tree.
    const lineages = computed(() => {
        const byKey = new Map();
        for (const key of tagDefs.value.keys()) {
            byKey.set(key, itemTagLineage(tagDefs.value, key));
        }
        return byKey;
    });

    const lineageOf = (key) => lineages.value.get(key) || [key];
    const isItemTag = (key) => tagDefs.value.has(key);
    const isSystemTag = (key) => Boolean(tagDefs.value.get(key)?.system);
    const isUserTag = (key) => tagDefs.value.has(key) && !isSystemTag(key);
    const itemTagLabel = (key) => tagDefs.value.get(key)?.label || key;
    const isFamilyTag = (key) => {
        const lineage = lineageOf(key);
        return lineage.length > 1 && lineage.includes(FAMILY_ROOT_TAG);
    };

    const userTagKeysByItem = computed(() => userTagsByItem(itemTags.value));

    // An item's own tags (not their ancestors): its system tags, then its user tags.
    const itemTagsOf = (itemId) => {
        const systemKeys = system.items[itemId] || [];
        const userKeys = userTagKeysByItem.value.get(String(itemId)) || [];
        return [...systemKeys, ...userKeys];
    };

    // The tags that color an item: its own tags minus "where it comes from" ones (shop-item,
    // boss-drop, ...), which say nothing about what the item is. All of them if that's all it has.
    const itemColorTagsOf = (itemId) => {
        const tags = itemTagsOf(itemId);
        const describing = tags.filter(key => !lineageOf(key).includes(SOURCE_ROOT_TAG));
        return describing.length ? describing : tags;
    };

    // Tag key -> Set of the ids (as strings) of the items that have it or a tag under it.
    const tagIndex = computed(() => {
        const idsByTag = new Map();
        for (const id of Object.keys(items.value)) {
            for (const ownTag of itemTagsOf(id)) {
                for (const key of lineageOf(ownTag)) {
                    if (!idsByTag.has(key)) {
                        idsByTag.set(key, new Set());
                    }
                    idsByTag.get(key).add(id);
                }
            }
        }
        return idsByTag;
    });

    const hasItemTag = (itemId, key) => Boolean(tagIndex.value.get(key)?.has(String(itemId)));
    const itemTagCount = (key) => tagIndex.value.get(key)?.size || 0;

    // The items with a tag (or a tag under it), by name.
    const itemsWithTag = (key) => {
        const ids = [...(tagIndex.value.get(key) || [])];
        return ids
            .map(id => items.value[id])
            .filter(Boolean)
            .sort((a, b) => a.name.localeCompare(b.name));
    };

    const optionsFor = (tags) => tags
        .map(tag => ({ key: tag.key, label: tag.label }))
        .sort((a, b) => a.label.localeCompare(b.label));

    // For tag pickers: [{ key, label }] by label. Every tag (linking a scope, choosing a parent),
    // or only user tags (anything that tags items).
    const itemTagOptions = computed(() => optionsFor([...tagDefs.value.values()]));
    const userTagOptions = computed(() => optionsFor([...tagDefs.value.values()].filter(tag => !tag.system)));

    // What the editors and tooltips look items up in (see FormulaInput's itemCatalog prop).
    const itemCatalog = computed(() => ({
        byId: items.value,
        byName: itemsByName.value,
        tagsOf: itemTagsOf,
        labelOf: itemTagLabel,
        isUserTag,
    }));

    // What queryOsrsItems() searches (see itemQuery.js).
    const itemQuerySource = {
        items: () => Object.values(items.value),
        tagsOf: itemTagsOf,
        hasTag: hasItemTag,
        isTag: isItemTag,
    };

    // --- Editing which items have a user tag ----------------------------------------------------

    const userTagEntry = (key) => itemTags.value.find(tag => tag.key === key) || null;

    const refuseSystemTag = (key) => {
        showToast(`"${itemTagLabel(key)}" is a system tag; system tags can't be changed.`, 'error');
    };

    // Adds items to a user tag. Returns the ids that weren't already on it.
    const addItemsToTag = (key, itemIds) => {
        const tag = userTagEntry(key);
        if (!tag) {
            refuseSystemTag(key);
            return [];
        }
        const added = [];
        for (const itemId of itemIds.map(Number)) {
            if (!tag.items.includes(itemId)) {
                tag.items.push(itemId);
                added.push(itemId);
            }
        }
        saveData();
        return added;
    };

    const itemsLabel = (itemIds) => {
        if (itemIds.length === 1) {
            return items.value[itemIds[0]]?.name || `item #${itemIds[0]}`;
        }
        return `${itemIds.length} items`;
    };

    // Takes a user tag off items, after a confirm, with an undo toast afterwards. Only items the
    // tag lists directly can be untagged (not ones it covers through a sub-tag).
    const removeItemsFromTag = (key, itemIds) => {
        const tag = userTagEntry(key);
        if (!tag) {
            refuseSystemTag(key);
            return;
        }
        const removing = itemIds.map(Number).filter(itemId => tag.items.includes(itemId));
        if (!removing.length) {
            return;
        }

        showConfirmModal(
            'Remove Item Tag',
            `Remove the tag "<strong>${tag.label}</strong>" from <strong>${itemsLabel(removing)}</strong>?`,
            () => {
                tag.items = tag.items.filter(itemId => !removing.includes(itemId));
                clearBulkSelection(removing);
                saveData();
                showUndoToast(`Removed "${tag.label}" from ${itemsLabel(removing)}.`, () => {
                    addItemsToTag(key, removing);
                    showToast(`Restored "${tag.label}" on ${itemsLabel(removing)}.`, 'success');
                });
            }
        );
    };

    const addTagToItem = (itemId, key) => {
        addItemsToTag(key, [itemId]);
    };

    const removeTagFromItem = (itemId, key) => {
        removeItemsFromTag(key, [itemId]);
    };

    // The tag typed text names: an existing tag by key or label (any case), or null.
    const findItemTagByText = (text) => {
        const wanted = text.trim().toLowerCase();
        for (const tag of tagDefs.value.values()) {
            if (tag.key === wanted || tag.label.toLowerCase() === wanted) {
                return tag.key;
            }
        }
        return null;
    };

    // --- Editing user tags themselves -----------------------------------------------------------

    // Adds a user tag. Returns its key (never a system tag's key).
    const createItemTag = (label, parent = null) => {
        const key = uniqueItemTagKey(slugifyItemTagKey(label), tagDefs.value);
        itemTags.value.push({ key, label: label.trim(), parent, items: [] });
        saveData();
        return key;
    };

    // Tags an item with the user tag typed text names, creating that tag when there's none.
    const addTagToItemByText = (itemId, text) => {
        if (!text.trim()) {
            return;
        }
        let key = findItemTagByText(text);
        if (key && isSystemTag(key)) {
            refuseSystemTag(key);
            return;
        }
        if (!key) {
            key = createItemTag(text);
            showToast(`Created item tag "${itemTagLabel(key)}".`, 'success');
        }
        addTagToItem(itemId, key);
    };

    const renameItemTag = (key) => {
        const tag = userTagEntry(key);
        if (!tag) {
            refuseSystemTag(key);
            return;
        }
        showInputModal('Rename Item Tag', tag.label, (label) => {
            if (!label || !label.trim()) {
                return;
            }
            tag.label = label.trim();
            saveData();
        });
    };

    // parent: any tag key, or null for a top-level tag. A tag can't go under itself or under one
    // of its own sub-tags.
    const setItemTagParent = (key, parent) => {
        const tag = userTagEntry(key);
        if (!tag) {
            refuseSystemTag(key);
            return;
        }
        const wouldLoop = parent && lineageOf(parent).includes(key);
        if (wouldLoop) {
            showToast("A tag can't go under one of its own sub-tags.", 'error');
            return;
        }
        tag.parent = parent || null;
        saveData();
    };

    // Everything deleting a tag changes, so it can be put back: the tag (and its place in the
    // list), sub-tags it was the parent of, and the scopes that linked it.
    const snapshotUserTag = (key) => ({
        index: itemTags.value.findIndex(tag => tag.key === key),
        tag: JSON.parse(JSON.stringify(userTagEntry(key))),
        childKeys: itemTags.value.filter(tag => tag.parent === key).map(tag => tag.key),
        scopeLinks: scopes.value
            .filter(scope => scope.itemTagKeys.includes(key))
            .map(scope => ({ scope, position: scope.itemTagKeys.indexOf(key) })),
    });

    const restoreUserTag = (snapshot) => {
        const { tag, index, childKeys, scopeLinks } = snapshot;
        itemTags.value.splice(Math.min(index, itemTags.value.length), 0, tag);
        for (const child of itemTags.value.filter(t => childKeys.includes(t.key))) {
            child.parent = tag.key;
        }
        for (const { scope, position } of scopeLinks) {
            if (!scope.itemTagKeys.includes(tag.key)) {
                scope.itemTagKeys.splice(position, 0, tag.key);
            }
        }
        saveData();
    };

    const forgetUserTag = (key) => {
        itemTags.value = itemTags.value.filter(tag => tag.key !== key);
        for (const tag of itemTags.value) {
            if (tag.parent === key) {
                tag.parent = null;
            }
        }
        for (const scope of scopes.value) {
            scope.itemTagKeys = scope.itemTagKeys.filter(k => k !== key);
        }
    };

    const deleteItemTag = (key) => {
        const tag = userTagEntry(key);
        if (!tag) {
            refuseSystemTag(key);
            return;
        }
        showConfirmModal(
            'Delete Item Tag',
            `Delete your item tag "<strong>${tag.label}</strong>"? It's removed from its ${tag.items.length} item(s) and from any scope that links it.`,
            () => {
                const snapshot = snapshotUserTag(key);
                forgetUserTag(key);
                if (selectedItemTagKey.value === key) {
                    selectedItemTagKey.value = null;
                }
                saveData();
                showUndoToast(`Deleted item tag "${tag.label}".`, () => {
                    restoreUserTag(snapshot);
                    selectedItemTagKey.value = key;
                    showToast(`Restored item tag "${tag.label}".`, 'success');
                });
            }
        );
    };

    // --- Item Tags tab: the tag lists -----------------------------------------------------------

    const itemTagSearch = ref('');
    const selectedItemTagKey = ref(null);
    const newItemTagLabel = ref('');

    const selectedItemTag = computed(() => tagDefs.value.get(selectedItemTagKey.value) || null);

    const matchesTagSearch = (row) => {
        const search = itemTagSearch.value.trim().toLowerCase();
        return !search || row.label.toLowerCase().includes(search) || row.key.includes(search);
    };

    // The user's tags, by label: [{ key, label, parentLabel, count }].
    const userTagRows = computed(() => itemTags.value
        .map(tag => ({
            key: tag.key,
            label: tag.label,
            parentLabel: tag.parent ? itemTagLabel(tag.parent) : '',
            count: itemTagCount(tag.key),
        }))
        .filter(matchesTagSearch)
        .sort((a, b) => a.label.localeCompare(b.label)));

    // The system tag tree in display order (each tag followed by its children, by label), as
    // [{ key, label, depth, count }]. While searching, only matching tags are listed.
    const systemTagRows = computed(() => {
        const childrenOf = new Map();
        for (const tag of tagDefs.value.values()) {
            if (!tag.system) {
                continue;
            }
            const parent = tag.parent && tagDefs.value.has(tag.parent) ? tag.parent : null;
            if (!childrenOf.has(parent)) {
                childrenOf.set(parent, []);
            }
            childrenOf.get(parent).push(tag);
        }

        const rows = [];
        const visit = (parent, depth, seen) => {
            const children = (childrenOf.get(parent) || []).sort((a, b) => a.label.localeCompare(b.label));
            for (const tag of children) {
                if (seen.has(tag.key)) {
                    continue;
                }
                seen.add(tag.key);
                rows.push({ key: tag.key, label: tag.label, depth, count: itemTagCount(tag.key) });
                visit(tag.key, depth + 1, seen);
            }
        };
        visit(null, 0, new Set());
        return rows.filter(matchesTagSearch);
    });

    const createItemTagFromInput = () => {
        const label = newItemTagLabel.value.trim();
        if (!label) {
            return;
        }
        selectedItemTagKey.value = createItemTag(label);
        newItemTagLabel.value = '';
        showToast(`Item tag "${label}" created.`, 'success');
    };

    // --- Item Tags tab: the selected tag's items, and bulk editing ------------------------------

    // Items as the item lists show them: colored by their tags (one shared palette, since this
    // isn't a scope), with their tags. directIds: the ids the selected user tag lists directly;
    // only those can be untagged (and ticked) here. Without it (search results) every row can be
    // ticked and none removed.
    const BROWSE_COLOR_SEED = 'item-tags';

    const browseRows = (itemList, directIds) => {
        const tagHues = allocateTagHues({
            seed: BROWSE_COLOR_SEED,
            itemTagLists: itemList.map(item => itemColorTagsOf(item.id)),
            isFamilyTag,
        });
        return itemList.map(item => ({
            ...item,
            color: autoItemColor({ seed: BROWSE_COLOR_SEED, itemId: item.id, tags: itemColorTagsOf(item.id), isFamilyTag, tagHues }),
            tags: itemTagsOf(item.id),
            removable: directIds ? directIds.has(item.id) : false,
            selectable: directIds ? directIds.has(item.id) : true,
        }));
    };

    const selectedItemTagItems = computed(() => {
        const tag = selectedItemTag.value;
        if (!tag) {
            return [];
        }
        const directIds = tag.system ? null : new Set(userTagEntry(tag.key)?.items || []);
        return browseRows(itemsWithTag(tag.key), directIds);
    });

    // Ticked rows of the selected user tag's list, for removing several at once.
    const bulkSelectedIds = ref([]);

    const clearBulkSelection = (itemIds = null) => {
        if (!itemIds) {
            bulkSelectedIds.value = [];
            return;
        }
        bulkSelectedIds.value = bulkSelectedIds.value.filter(id => !itemIds.includes(id));
    };

    watch(selectedItemTagKey, () => {
        clearBulkSelection();
        clearAddSelection();
        tagAddSearch.value = '';
    });

    const toggleSelection = (listRef, itemId) => {
        const list = listRef.value;
        listRef.value = list.includes(itemId) ? list.filter(id => id !== itemId) : [...list, itemId];
    };

    const toggleBulkSelected = (itemId) => toggleSelection(bulkSelectedIds, itemId);

    const removableItemIds = computed(() => selectedItemTagItems.value.filter(item => item.removable).map(item => item.id));

    const selectAllBulk = () => {
        bulkSelectedIds.value = [...removableItemIds.value];
    };

    const removeBulkSelected = () => {
        if (!selectedItemTag.value || !bulkSelectedIds.value.length) {
            return;
        }
        removeItemsFromTag(selectedItemTag.value.key, bulkSelectedIds.value);
    };

    // Adding items to the selected user tag: a search (name / ID / tag:<key>, as on the Scopes
    // tab) over items the tag doesn't have yet, whose results can be ticked or all added.
    const TAG_ADD_RESULT_LIMIT = 100;
    const tagAddSearch = ref('');
    const tagAddSelectedIds = ref([]);

    const clearAddSelection = () => {
        tagAddSelectedIds.value = [];
    };

    const tagAddUnknownTags = computed(() => parseItemSearch(tagAddSearch.value).tags.filter(key => !isItemTag(key)));

    const tagAddMatches = computed(() => {
        const tag = selectedItemTag.value;
        const search = parseItemSearch(tagAddSearch.value);
        const isEmpty = !search.text && !search.tags.length;
        if (!tag || tag.system || isEmpty || tagAddUnknownTags.value.length) {
            return [];
        }
        const candidates = Object.values(items.value).filter(item => {
            return !hasItemTag(item.id, tag.key) && search.tags.every(key => hasItemTag(item.id, key));
        });
        return rankItemsByText(candidates, search.text);
    });

    const tagAddResults = computed(() => browseRows(tagAddMatches.value.slice(0, TAG_ADD_RESULT_LIMIT), null));

    const toggleAddSelected = (itemId) => toggleSelection(tagAddSelectedIds, itemId);

    const addItemsToSelectedTag = (itemIds) => {
        const tag = selectedItemTag.value;
        if (!tag || !itemIds.length) {
            return;
        }
        const added = addItemsToTag(tag.key, itemIds);
        clearAddSelection();
        showUndoToast(`Tagged ${itemsLabel(added)} "${tag.label}".`, () => {
            const entry = userTagEntry(tag.key);
            if (entry) {
                entry.items = entry.items.filter(itemId => !added.includes(itemId));
                saveData();
            }
        });
    };

    const addSelectedToTag = () => addItemsToSelectedTag(tagAddSelectedIds.value);
    const addAllMatchesToTag = () => addItemsToSelectedTag(tagAddMatches.value.map(item => item.id));

    // --- Market tab -----------------------------------------------------------------------------

    // Clicking an item gives it the selected user tag.
    const tagItemWithSelectedTag = (item) => {
        const key = selectedItemTagKey.value;
        if (!key || !isUserTag(key)) {
            showToast('Pick one of your item tags first.', 'info');
            return;
        }
        if (userTagEntry(key).items.includes(Number(item.id))) {
            showToast(`${item.name} already has the tag "${itemTagLabel(key)}".`, 'info');
            return;
        }
        addTagToItem(item.id, key);
        showToast(`Tagged ${item.name} "${itemTagLabel(key)}".`, 'success');
    };

    return {
        tagDefs, itemTagOptions, userTagOptions, itemCatalog, itemQuerySource,
        isItemTag, isSystemTag, isUserTag, isFamilyTag, itemTagLabel,
        itemTagsOf, itemColorTagsOf, hasItemTag, itemTagCount, itemsWithTag,
        addTagToItem, removeTagFromItem, addTagToItemByText,
        createItemTag, renameItemTag, setItemTagParent, deleteItemTag,
        itemTagSearch, selectedItemTagKey, newItemTagLabel, selectedItemTag, selectedItemTagItems,
        userTagRows, systemTagRows, createItemTagFromInput,
        bulkSelectedIds, toggleBulkSelected, selectAllBulk, clearBulkSelection, removeBulkSelected, removableItemIds,
        tagAddSearch, tagAddResults, tagAddMatches, tagAddUnknownTags, tagAddSelectedIds, toggleAddSelected,
        addSelectedToTag, addAllMatchesToTag,
        tagItemWithSelectedTag,
    };
};
