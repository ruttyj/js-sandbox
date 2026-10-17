// All GE items (from the OSRS wiki prices API) plus market search.
const ITEM_MAPPING_URL = 'https://prices.runescape.wiki/api/v1/osrs/mapping';
const ITEM_PRICES_URL = 'https://prices.runescape.wiki/api/v1/osrs/latest';

const readJsonResponse = (response, errorMessage) => {
    if (!response.ok) throw new Error(errorMessage);
    return response.json();
};

// The API's high/low can be inverted; the larger is always shown as "high". When one of them is
// missing, both read as the low price.
const orderedPrices = (priceInfo) => {
    const high = priceInfo?.high;
    const low = priceInfo?.low;
    return { highPrice: high > low ? high : low, lowPrice: high < low ? high : low };
};

// mapping: [{ id, name, ... }] from the mapping API; prices: { [id]: { high, low } }.
// Returns { byId: { [id]: item }, byName: Map<itemNameKey, item> }.
const buildItemIndex = (mapping, prices) => {
    const byId = {};
    const byName = new Map();
    mapping.forEach(entry => {
        const item = { ...entry, ...orderedPrices(prices[entry.id]) };
        byId[entry.id] = item;
        // A few names are shared by several items; the first one listed wins.
        const nameKey = itemNameKey(entry.name);
        if (!byName.has(nameKey)) byName.set(nameKey, item);
    });
    return { byId, byName };
};

const useRunescapeItems = ({ showToast }) => {
    const items = ref({}); // Map indexed by ID
    const itemsByName = ref(new Map()); // itemNameKey(name) -> item, for getOsrsItem('Name')
    const loading = ref(true);
    const error = ref(null);

    const searchText = ref('');
    const searchQuery = ref('');

    const filteredItems = computed(() => {
        const allItems = Object.values(items.value);
        if (!searchQuery.value) return allItems;
        const lowerCaseSearch = searchQuery.value.toLowerCase();
        return allItems.filter(item => item.name.toLowerCase().includes(lowerCaseSearch));
    });

    const loadItems = async () => {
        try {
            loading.value = true;
            error.value = null;
            // Both requests run at once; the mapping is checked first so its error wins.
            const [mappingResponse, pricesResponse] = await Promise.all([fetch(ITEM_MAPPING_URL), fetch(ITEM_PRICES_URL)]);
            const mapping = await readJsonResponse(mappingResponse, 'Failed to fetch items mapping');
            const latest = await readJsonResponse(pricesResponse, 'Failed to fetch latest prices');
            const { byId, byName } = buildItemIndex(mapping, latest.data);
            items.value = byId;
            itemsByName.value = byName;
        } catch (e) {
            error.value = e.message;
            console.error("Failed to fetch items:", e);
        } finally {
            loading.value = false;
        }
    };

    const refreshPrices = async () => {
        await loadItems();
        if (error.value) return;
        showToast('Prices refreshed.', 'success');
    };

    const debouncedSetSearchQuery = debounce((value) => {
        searchQuery.value = value;
    }, 500);

    watch(searchText, debouncedSetSearchQuery);

    return { items, itemsByName, loading, error, filteredItems, searchText, searchQuery, loadItems, refreshPrices };
};
