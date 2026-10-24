// queryOsrsItems(): a query builder user code can use to search and filter every GE item.
//
//   const seeds = queryOsrsItems().tagged('tree-seed').sortBy('highPrice', 'desc').list();
//   const maple = queryOsrsItems().tagged('maple').nameMatches(/sapling|seed/).list();
//   const cheap = queryOsrsItems().tagged('rune', 'armour').priceBetween(0, 50_000).count();
//
// Each method returns a new query, so a partial query can be reused:
//   const farming = queryOsrsItems().tagged('farming');
//   const herbSeeds = farming.tagged('herb-seed').list();
//
// Filters:  tagged(...keys)     has every tag (or a tag under it: 'seed' matches tree seeds)
//           taggedAny(...keys)  has at least one of them
//           notTagged(...keys)  has none of them
//           nameMatches(text or RegExp)  text: case-insensitive "contains"
//           members(flag = true)         members' items only (false: free-to-play only)
//           priceBetween(min, max, field = 'highPrice')  null leaves a side open
//           where(item => boolean)
// Order:    sortBy(field or item => value, 'asc' | 'desc'), limit(n)
// Results:  list() -> items, first() -> item or null, count(), ids()
// Items look like getOsrsItem's (see toCodeItem in itemRefs.js).
//
// Everything is private to the ItemQuery closure except the names in its returned object, which
// are also exposed as globals for the other scripts.

const ItemQuery = (() => {

    const ITEM_QUERY_FN = 'queryOsrsItems';

    /**
     * Where a query reads items and tags from.
     * @typedef {Object} ItemQuerySource
     * @property {function(): Object[]} items Every item (as loaded by useRunescapeItems).
     * @property {function(number|string): string[]} tagsOf An item's own tags.
     * @property {function(number|string, string): boolean} hasTag Whether an item has the tag
     *     or a tag under it.
     * @property {function(string): boolean} isTag Whether a tag key exists.
     */

    // Tag keys are lowercase; checking them here turns a typo into a clear error rather than an
    // empty result.
    const checkedTagKeys = (source, keys) => {
        const flat = keys.flat().map(key => String(key).trim().toLowerCase());
        for (const key of flat) {
            if (!source.isTag(key)) {
                throw new Error(`Unknown item tag "${key}"`);
            }
        }
        return flat;
    };

    const nameMatcher = (pattern) => {
        if (pattern instanceof RegExp) {
            return (name) => {
                pattern.lastIndex = 0;
                return pattern.test(name);
            };
        }
        const text = String(pattern).toLowerCase();
        return (name) => name.toLowerCase().includes(text);
    };

    const resultItem = (source, item) => toCodeItem(item, source.tagsOf(item.id));

    // field: a result item's field name, or a function of the item.
    const sortValue = (field) => {
        if (typeof field === 'function') {
            return field;
        }
        return (item) => item[field];
    };

    const compareValues = (a, b) => {
        if (typeof a === 'string' || typeof b === 'string') {
            return String(a ?? '').localeCompare(String(b ?? ''));
        }
        return (a ?? 0) - (b ?? 0);
    };

    // Filters that only need the raw item run first, so the result items (which look up their
    // tags) are only built for the items that pass them.
    const runQuery = (source, state) => {
        let matches = source.items().filter(item => state.rawFilters.every(filter => filter(item)));
        let results = matches.map(item => resultItem(source, item));
        results = results.filter(item => state.resultFilters.every(filter => filter(item)));

        if (state.sort) {
            const valueOf = sortValue(state.sort.field);
            const direction = state.sort.direction === 'desc' ? -1 : 1;
            results.sort((a, b) => direction * compareValues(valueOf(a), valueOf(b)));
        }
        if (state.limit !== null) {
            results = results.slice(0, state.limit);
        }
        return results;
    };

    /**
     * A query over the source's items.
     * @param {ItemQuerySource} source
     * @param {Object} [state] The query so far (internal).
     * @returns {Object} The query builder (see the top of this file).
     */
    const createItemQuery = (source, state = { rawFilters: [], resultFilters: [], sort: null, limit: null }) => {
        const withRawFilter = (filter) => createItemQuery(source, { ...state, rawFilters: [...state.rawFilters, filter] });
        const withResultFilter = (filter) => createItemQuery(source, { ...state, resultFilters: [...state.resultFilters, filter] });

        return Object.freeze({
            tagged: (...keys) => {
                const wanted = checkedTagKeys(source, keys);
                return withRawFilter(item => wanted.every(key => source.hasTag(item.id, key)));
            },
            taggedAny: (...keys) => {
                const wanted = checkedTagKeys(source, keys);
                return withRawFilter(item => wanted.some(key => source.hasTag(item.id, key)));
            },
            notTagged: (...keys) => {
                const unwanted = checkedTagKeys(source, keys);
                return withRawFilter(item => !unwanted.some(key => source.hasTag(item.id, key)));
            },
            nameMatches: (pattern) => {
                const matches = nameMatcher(pattern);
                return withRawFilter(item => matches(item.name));
            },
            members: (flag = true) => withRawFilter(item => Boolean(item.members) === Boolean(flag)),
            priceBetween: (min, max, field = 'highPrice') => withRawFilter(item => {
                const price = item[field] || 0;
                const aboveMin = min === null || min === undefined || price >= min;
                const belowMax = max === null || max === undefined || price <= max;
                return aboveMin && belowMax;
            }),
            where: (predicate) => withResultFilter(item => Boolean(predicate(item))),
            sortBy: (field, direction = 'asc') => createItemQuery(source, { ...state, sort: { field, direction } }),
            limit: (count) => createItemQuery(source, { ...state, limit: Math.max(0, Math.floor(count)) }),
            list: () => runQuery(source, state),
            first: () => runQuery(source, { ...state, limit: 1 })[0] || null,
            count: () => runQuery(source, state).length,
            ids: () => runQuery(source, state).map(item => item.id),
        });
    };

    // A source over items alone, for code run without tag data: every tag is unknown.
    const untaggedItemSource = (itemsById) => ({
        items: () => Object.values(itemsById),
        tagsOf: () => [],
        hasTag: () => false,
        isTag: () => false,
    });


    // --- Public API -------------------------------------------------------------------------------

    return Object.freeze({
        ITEM_QUERY_FN,
        createItemQuery,
        untaggedItemSource,
    });
})();

// Classic scripts share one global scope, so the public API is unpacked here for the files that
// follow (the same way vue-globals.js unpacks Vue).
const {
    ITEM_QUERY_FN,
    createItemQuery,
    untaggedItemSource,
} = ItemQuery;
