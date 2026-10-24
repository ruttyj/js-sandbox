// Item tags: labels for finding GE items among thousands (seed, maple, rune, platebody, ...).
// They're a separate thing from variable tags (PROFIT, TAX, ...), which label a scope's values.
//
// There are two kinds:
//   system tags  BUILTIN_ITEM_TAG_DATA (data/itemTagData.js), generated from the wiki. Read-only:
//                they can't be renamed, re-parented, deleted, or added to / removed from items.
//   user tags    the user's own, saved with the rest of the app's data as
//                itemTags: [{ key, label, parent, items: [itemId, ...] }]
//                Fully editable. A user tag may sit under a system tag (parent), not vice versa.
// Tags form a tree (one parent each). An item tagged `tree-seed` also counts as `seed` and
// `farming` when those are its ancestors; only its own tags are stored.

// Keys are lowercase kebab-case: "Tree seeds" -> "tree-seeds", "Ahrim's" -> "ahrims".
const slugifyItemTagKey = (text) => {
    return String(text)
        .trim()
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
};

// base, or base-2, base-3, ... when that key is taken. takenKeys: a Set or Map of keys.
const uniqueItemTagKey = (base, takenKeys) => {
    let key = base || 'tag';
    for (let n = 2; takenKeys.has(key); n++) {
        key = `${base}-${n}`;
    }
    return key;
};

// Every tag definition by key. A user tag that reuses a system key is ignored (system tags
// can't be overridden).
// Returns Map<key, { key, label, parent, description, system }>.
const buildItemTagDefs = (systemTags, userTags) => {
    const defs = new Map();
    for (const tag of systemTags) {
        defs.set(tag.key, {
            key: tag.key,
            label: tag.label || tag.key,
            parent: tag.parent || null,
            description: tag.description || '',
            system: true,
        });
    }

    for (const tag of userTags) {
        if (defs.has(tag.key)) {
            continue;
        }
        defs.set(tag.key, {
            key: tag.key,
            label: tag.label || tag.key,
            parent: tag.parent || null,
            description: '',
            system: false,
        });
    }
    return defs;
};

// A tag followed by its ancestors: 'tree-seed' -> ['tree-seed', 'seed', 'farming', 'skilling'].
// A parent that isn't defined ends the chain, and so does a loop.
const itemTagLineage = (defs, key) => {
    const lineage = [];
    let current = key;
    while (current && !lineage.includes(current)) {
        lineage.push(current);
        current = defs.get(current)?.parent || null;
    }
    return lineage;
};

// Item id (as a string) -> the keys of the user tags that list it.
const userTagsByItem = (userTags) => {
    const byItem = new Map();
    for (const tag of userTags) {
        for (const itemId of tag.items) {
            const id = String(itemId);
            if (!byItem.has(id)) {
                byItem.set(id, []);
            }
            byItem.get(id).push(tag.key);
        }
    }
    return byItem;
};

// The saved shape of user tags, whatever was loaded or imported: { key, label, parent, items }
// with items a list of unique numeric ids. Entries without a key are dropped.
const normalizeUserItemTag = (tag) => ({
    key: String(tag.key),
    label: tag.label || String(tag.key),
    parent: tag.parent || null,
    items: [...new Set((tag.items || []).map(Number).filter(Number.isFinite))],
});

const normalizeItemTagData = (data) => {
    const tags = Array.isArray(data.itemTags) ? data.itemTags : [];
    data.itemTags = tags.filter(tag => tag && tag.key).map(normalizeUserItemTag);
    return data;
};

// --- Searching items -------------------------------------------------------------------------

// A search box's text as { tags, text }: "tag:<key>" words are tags (lowercased), the rest is
// name / ID text. "tag:seed maple" -> { tags: ['seed'], text: 'maple' }.
const parseItemSearch = (input) => {
    const tags = [];
    const words = [];
    for (const word of String(input).trim().split(/\s+/)) {
        const tagMatch = word.match(/^tag:(.+)$/i);
        if (tagMatch) {
            tags.push(tagMatch[1].toLowerCase());
        } else if (word) {
            words.push(word);
        }
    }
    return { tags, text: words.join(' ').toLowerCase() };
};

// How well an item matches search text: 0 (exact ID) .. 4 (name contains it), -1 for no match.
const itemTextRank = (item, text) => {
    const name = item.name.toLowerCase();
    const id = String(item.id);
    const isId = /^\d+$/.test(text);
    if (isId && id === text) {
        return 0;
    }
    if (name === text) {
        return 1;
    }
    if (name.startsWith(text)) {
        return 2;
    }
    if (isId && id.startsWith(text)) {
        return 3;
    }
    if (name.includes(text)) {
        return 4;
    }
    return -1;
};

// The items matching text (lowercase), best matches first, then by name. Empty text keeps every
// item, by name.
const rankItemsByText = (items, text) => {
    const ranked = [];
    for (const item of items) {
        const rank = text ? itemTextRank(item, text) : 0;
        if (rank >= 0) {
            ranked.push({ item, rank });
        }
    }
    ranked.sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name));
    return ranked.map(entry => entry.item);
};
