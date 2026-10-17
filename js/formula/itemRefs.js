// How user code refers to GE items: the getOsrsItem('Name') / getOsrsItem(id) lookup, the code
// that's generated for it (when an item is inserted into the editor or legacy refs are migrated),
// and how an argument finds its item. The lookup itself runs in the engine (see createItemLookup).
//
// Everything is private to the ItemRefs closure except the names in its returned object, which
// are also exposed as globals for the other scripts.

/**
 * A GE item, as loaded by useRunescapeItems. Declared outside the closure so other files' doc
 * comments (engine.js) can refer to it.
 * @typedef {Object} Item
 * @property {number} id
 * @property {string} name
 * @property {number} [highPrice]
 * @property {number} [lowPrice]
 */

const ItemRefs = (() => {

    /** getOsrsItem('Name') or getOsrsItem(id) in the code: an item's prices. */
    const ITEM_LOOKUP_FN = 'getOsrsItem';

    /**
     * The key for an item in the name -> item index built by useRunescapeItems, so lookups ignore
     * case and surrounding spaces.
     * @param {*} name
     * @returns {string}
     */
    const itemNameKey = (name) => {
        return String(name).trim().toLowerCase();
    };

    // An item ID written as text: "5316" or " 5316 ". No item name is only digits.
    const ITEM_ID_TEXT = /^\s*\d+\s*$/;

    /**
     * Whether a getOsrsItem argument is an item ID rather than a name.
     * @example isItemIdArg(5316)         // -> true
     * @example isItemIdArg('5316')       // -> true
     * @example isItemIdArg('Magic seed') // -> false
     * @param {*} nameOrId
     * @returns {boolean}
     */
    const isItemIdArg = (nameOrId) => {
        if (typeof nameOrId === 'number') {
            return true;
        }
        return typeof nameOrId === 'string' && ITEM_ID_TEXT.test(nameOrId);
    };

    /**
     * The item a getOsrsItem argument refers to: an item ID (a number or a string of digits) or
     * an item name (case and surrounding spaces ignored).
     * @param {string|number} nameOrId
     * @param {Object<string, Item>} itemsById
     * @param {Map<string, Item>} itemsByName Items by itemNameKey(name).
     * @returns {Item|null} null for an unknown item.
     */
    const findItem = (nameOrId, itemsById, itemsByName) => {
        if (isItemIdArg(nameOrId)) {
            return itemsById[String(nameOrId).trim()] || null;
        }
        return itemsByName.get(itemNameKey(nameOrId)) || null;
    };

    /**
     * An item name as a string literal for code.
     * @example quoteItemName('Cannonball')   // -> 'Cannonball'
     * @example quoteItemName("Ahrim's hood") // -> "Ahrim's hood"
     * @param {string} name
     * @returns {string} Single-quoted, or double-quoted when the name itself contains an apostrophe.
     */
    const quoteItemName = (name) => {
        if (name.includes("'")) {
            return JSON.stringify(name);
        }
        return `'${name}'`;
    };

    /**
     * The code that looks an item up.
     * @example buildItemLookup({ name: 'Cannonball' }) // -> getOsrsItem('Cannonball')
     * @param {{ name: string }} item
     * @returns {string}
     */
    const buildItemLookup = (item) => {
        return `${ITEM_LOOKUP_FN}(${quoteItemName(item.name)})`;
    };

    /**
     * The code that reads one of an item's prices.
     * @example buildItemRef({ name: 'Cannonball' }, 'HIGH') // -> getOsrsItem('Cannonball').highPrice
     * @param {{ name: string }} item
     * @param {'HIGH'|'LOW'} type
     * @returns {string}
     */
    const buildItemRef = (item, type) => {
        const field = type === 'HIGH' ? 'highPrice' : 'lowPrice';
        return `${buildItemLookup(item)}.${field}`;
    };


    // --- Public API -------------------------------------------------------------------------------

    return Object.freeze({
        ITEM_LOOKUP_FN,
        itemNameKey,
        isItemIdArg,
        findItem,
        quoteItemName,
        buildItemLookup,
        buildItemRef,
    });
})();

// Classic scripts share one global scope, so the public API is unpacked here for the files that
// follow (the same way vue-globals.js unpacks Vue).
const {
    ITEM_LOOKUP_FN,
    itemNameKey,
    isItemIdArg,
    findItem,
    quoteItemName,
    buildItemLookup,
    buildItemRef,
} = ItemRefs;
