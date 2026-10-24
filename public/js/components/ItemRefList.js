// A list of items shown as the code that reads them: color, icon, getOsrsItem('Name'), the item
// ID, a price graph link, the item's tags, an RS-formatted "low - high" price range and the
// spread between them. Clicking the getOsrsItem(...) chip or the ID emits `copy` with that text;
// clicking a price emits `insert` for its `.lowPrice` / `.highPrice` ref.
//
// items: [{ id, name, highPrice, lowPrice, color, tags?, removable? }]
// sortable: a bar above the list sorts it by name, low price, high price or spread. Only the
//   items passed in are sorted (a list cut short by its parent sorts what it shows).
// colorEditable: the swatch is a color picker (emits set-color(itemId, color)).
// taggable: show each item's tags (needs tagLabel: key -> label; isUserTag: key -> boolean; and
//   tagOptions: [{ key, label }], the user tags to suggest). A tag chip emits filter-tag(key);
//   a user tag's × emits remove-tag(itemId, key) (system tags can't be removed); the + button
//   lets the user type a tag and emits add-tag(itemId, text).
// removable: a remove button on each row whose item.removable isn't false (emits remove(itemId)).
// selectable: a checkbox on each row whose item.selectable isn't false, ticked for ids in
//   selectedIds (emits toggle-select(itemId)).

let itemRefListCount = 0;

// --- Sorting ----------------------------------------------------------------------------------

// What the list can be sorted by. A missing value (no price) is null and always sorts last.
// Names start A-Z; numbers start with the largest, the usual first question about a price.
const ITEM_REF_SORTS = [
    { key: 'name', label: 'Name', firstDirection: 'asc', valueOf: (item) => item.name },
    { key: 'low', label: 'Low', firstDirection: 'desc', valueOf: (item) => item.lowPrice || null },
    { key: 'high', label: 'High', firstDirection: 'desc', valueOf: (item) => item.highPrice || null },
    { key: 'spread', label: 'Spread', firstDirection: 'desc', valueOf: itemSpread },
];

const compareItemRefValues = (a, b) => {
    if (typeof a === 'string') {
        return a.localeCompare(b);
    }
    return a - b;
};

// A sorted copy of the items. Ties keep the order they were passed in (sort is stable).
const sortItemRefs = (items, sort, direction) => {
    const sign = direction === 'desc' ? -1 : 1;
    return [...items].sort((itemA, itemB) => {
        const a = sort.valueOf(itemA);
        const b = sort.valueOf(itemB);
        if (a === null || b === null) {
            // Missing values go last whichever way the list is sorted.
            return (a === null) - (b === null);
        }
        return sign * compareItemRefValues(a, b);
    });
};

// The sort after clicking a column: a new column starts in its first direction, a second click
// flips it, and a third goes back to the order the items were passed in.
// current / returns: { key, direction }, or null for unsorted.
const nextItemRefSort = (current, sort) => {
    if (!current || current.key !== sort.key) {
        return { key: sort.key, direction: sort.firstDirection };
    }

    if (current.direction === sort.firstDirection) {
        const flipped = sort.firstDirection === 'asc' ? 'desc' : 'asc';
        return { key: sort.key, direction: flipped };
    }
    return null;
};

// --- Component --------------------------------------------------------------------------------

const ItemRefList = {
    components: { 'item-icon': ItemIcon },
    props: {
        items: Array,
        colorEditable: Boolean,
        taggable: Boolean,
        tagLabel: Function,
        isUserTag: Function,
        tagOptions: Array,
        removable: Boolean,
        removeTitle: { type: String, default: 'Remove' },
        selectable: Boolean,
        selectedIds: Array,
        sortable: Boolean,
    },
    emits: ['insert', 'copy', 'set-color', 'filter-tag', 'add-tag', 'remove-tag', 'remove', 'toggle-select'],
    setup(props, { emit }) {
        const formatPrice = (price) => (price ? formatRSNumber(price) : '—');
        const exactPrice = (price) => (price ? price.toLocaleString() : 'no price');
        const labelOf = (key) => (props.tagLabel ? props.tagLabel(key) : key);
        const isEditableTag = (key) => Boolean(props.isUserTag && props.isUserTag(key));
        const isSelected = (itemId) => (props.selectedIds || []).includes(itemId);

        // Each list needs its own <datalist> id.
        itemRefListCount += 1;
        const tagOptionsId = `item-ref-tag-options-${itemRefListCount}`;

        // The row whose "add tag" box is open (one at a time), and what's typed in it.
        const taggingItemId = ref(null);
        const newTagText = ref('');

        const startTagging = (itemId) => {
            taggingItemId.value = itemId;
            newTagText.value = '';
        };

        const stopTagging = () => {
            taggingItemId.value = null;
        };

        const submitTag = () => {
            const text = newTagText.value.trim();
            if (text) {
                emit('add-tag', taggingItemId.value, text);
            }
            stopTagging();
        };

        // Focuses the box as it appears (used as a function ref).
        const focusOnMount = (el) => {
            if (el) {
                el.focus();
            }
        };

        // { key, direction } of the column the list is sorted by, or null for the order given.
        const currentSort = ref(null);

        const toggleSort = (sort) => {
            currentSort.value = nextItemRefSort(currentSort.value, sort);
        };

        const sortArrow = (sort) => {
            if (!currentSort.value || currentSort.value.key !== sort.key) {
                return '';
            }
            return currentSort.value.direction === 'asc' ? '▲' : '▼';
        };

        const shownItems = computed(() => {
            const items = props.items || [];
            if (!currentSort.value) {
                return items;
            }
            const sort = ITEM_REF_SORTS.find(option => option.key === currentSort.value.key);
            return sortItemRefs(items, sort, currentSort.value.direction);
        });

        const formatSpread = (item) => {
            const spread = itemSpread(item);
            if (spread === null) {
                return '—';
            }
            return formatRSNumber(spread);
        };

        const exactSpread = (item) => {
            const spread = itemSpread(item);
            if (spread === null) {
                return 'no spread: a price is missing';
            }
            return `Spread (high − low): ${spread.toLocaleString()}`;
        };

        return {
            formatPrice, exactPrice, labelOf, isEditableTag, isSelected, quoteItemName, buildItemLookup,
            tagOptionsId, taggingItemId, newTagText, startTagging, stopTagging, submitTag, focusOnMount,
            ITEM_REF_SORTS, currentSort, toggleSort, sortArrow, shownItems, formatSpread, exactSpread,
        };
    },
    template: `
        <div class="item-ref-list">
            <datalist v-if="taggable" :id="tagOptionsId">
                <option v-for="option in tagOptions || []" :key="option.key" :value="option.label">{{ option.key }}</option>
            </datalist>
            <div v-if="sortable" class="item-ref-sort-bar">
                <span class="item-ref-sort-label">Sort</span>
                <button
                    v-for="sort in ITEM_REF_SORTS"
                    :key="sort.key"
                    class="item-ref-sort-btn"
                    :class="{ active: currentSort && currentSort.key === sort.key }"
                    :title="'Sort by ' + sort.label.toLowerCase() + '; click again to reverse, a third time to unsort'"
                    @click="toggleSort(sort)"
                >{{ sort.label }}<span class="item-ref-sort-arrow">{{ sortArrow(sort) }}</span></button>
            </div>
            <div v-for="item in shownItems" :key="item.id" class="item-ref-row" :class="{ selected: selectable && isSelected(item.id) }">
                <input v-if="selectable && item.selectable !== false" type="checkbox" class="item-ref-check" :checked="isSelected(item.id)" @change="$emit('toggle-select', item.id)">
                <input v-if="colorEditable" type="color" :value="item.color" class="color-picker-input item-ref-color" title="Item color in this scope" @input="$emit('set-color', item.id, $event.target.value)">
                <span v-else class="item-ref-swatch" :style="{ backgroundColor: item.color }"></span>
                <item-icon :item="item" class="item-ref-icon"></item-icon>
                <code class="item-ref-code"
                      :style="{ backgroundColor: item.color + '30', boxShadow: '0 0 0 1px ' + item.color + '80' }"
                      title="Click to copy"
                      @click="$emit('copy', buildItemLookup(item))"><span class="code-fn">getOsrsItem</span>(<span class="code-string">{{ quoteItemName(item.name) }}</span>)</code>
                <span class="item-ref-id" title="Click to copy the item ID" @click="$emit('copy', String(item.id))">#{{ item.id }}</span>
                <a class="item-ref-graph" target="_blank" rel="noopener" :href="'https://prices.osrs.cloud/item/' + item.id" title="Open the price graph">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-5 4 4 8-9"/><path d="M15 7h5v5"/></svg>
                </a>
                <span v-if="taggable" class="item-ref-tags">
                    <span v-for="key in item.tags || []" :key="key" class="item-tag-chip" :class="isEditableTag(key) ? 'user' : 'system'">
                        <span class="item-tag-chip-label" :title="(isEditableTag(key) ? 'Your tag ' : 'System tag ') + key + ': click to list its items'" @click="$emit('filter-tag', key)">{{ labelOf(key) }}</span>
                        <span v-if="isEditableTag(key)" class="item-tag-chip-remove" title="Remove this tag from the item" @click="$emit('remove-tag', item.id, key)">×</span>
                    </span>
                    <input
                        v-if="taggingItemId === item.id"
                        :ref="focusOnMount"
                        v-model="newTagText"
                        class="item-tag-input"
                        :list="tagOptionsId"
                        placeholder="tag…"
                        spellcheck="false"
                        @keydown.enter.prevent="submitTag"
                        @keydown.esc="stopTagging"
                        @blur="stopTagging"
                    >
                    <button v-else class="item-tag-add" title="Tag this item" @click="startTagging(item.id)">+</button>
                </span>
                <span class="item-ref-prices">
                    <span class="item-ref-price price-clickable price-val-low" @mousedown.prevent="$emit('insert', item.id, 'LOW')" :title="'Insert .lowPrice (' + exactPrice(item.lowPrice) + ')'">{{ formatPrice(item.lowPrice) }}</span>
                    <span class="item-ref-price-sep">–</span>
                    <span class="item-ref-price price-clickable price-val-high" @mousedown.prevent="$emit('insert', item.id, 'HIGH')" :title="'Insert .highPrice (' + exactPrice(item.highPrice) + ')'">{{ formatPrice(item.highPrice) }}</span>
                    <span class="item-ref-spread" :title="exactSpread(item)">Δ {{ formatSpread(item) }}</span>
                </span>
                <button v-if="removable && item.removable !== false" class="item-ref-remove" :title="removeTitle" @click="$emit('remove', item.id)">×</button>
            </div>
        </div>
    `
};
