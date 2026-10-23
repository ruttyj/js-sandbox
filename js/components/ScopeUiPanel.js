// The UI section beside a code editor: draws the panels the code's ui calls made (see
// uiLibrary.js for the panel shapes). Hovering an item (a tile, an item cell or an item stat)
// shows the same FormulaTooltip card as the code editors.
//
// Panels are plain data, so nothing here runs user code. A table's sort, search and "show all"
// live in its component, which is keyed by the panel's position and title, so they're kept while
// the code re-runs on every keystroke.
//
// Uses globals from scripts loaded before it:
//   utils/format.js            formatRSNumber
//   components/ItemIcon.js     ItemIcon
//   components/FormulaTooltip  FormulaTooltip
//   components/FormulaInput.js catalogItemTags, isCatalogLoaded
//   composables/useEditorSettings.js  editorSettings (uiInSidebar)
//
// Sections: formatting cells -> sorting -> searching -> item hover card -> components.


// --- Formatting cells -------------------------------------------------------------------------

const UI_EMPTY_CELL = '—';
const UI_TABLE_PAGE_ROWS = 100;

const uiExactNumber = (value) => value.toLocaleString(undefined, { maximumFractionDigits: 6 });

// A numeric cell as display text. decimals: from the column, or null for the type's default.
const uiNumberText = (type, value, decimals) => {
    if (type === 'price' || type === 'rsNumber') {
        return String(formatRSNumber(value));
    }
    if (type === 'signedPrice') {
        const sign = value > 0 ? '+' : '';
        return sign + formatRSNumber(value);
    }
    if (type === 'percent') {
        return `${(value * 100).toFixed(decimals ?? 1)}%`;
    }
    return value.toLocaleString(undefined, {
        minimumFractionDigits: decimals ?? 0,
        maximumFractionDigits: decimals ?? 2,
    });
};

// What a non-item cell shows: { text, title, tone }. tone: 'up' / 'down' for signed prices.
const uiCellDisplay = (type, value, decimals) => {
    if (type === 'boolean') {
        return { text: value ? '✓' : '✗', title: '', tone: value ? 'up' : 'muted' };
    }
    if (type === 'text') {
        return { text: value, title: value.length > 40 ? value : '', tone: '' };
    }
    if (typeof value !== 'number') {
        return { text: UI_EMPTY_CELL, title: '', tone: 'muted' };
    }

    let tone = '';
    if (type === 'signedPrice' && value !== 0) {
        tone = value > 0 ? 'up' : 'down';
    }
    return { text: uiNumberText(type, value, decimals), title: uiExactNumber(value), tone };
};


// --- Sorting ----------------------------------------------------------------------------------

// The value a cell sorts by, or null for an empty cell (always sorted last).
const uiSortKey = (type, cell) => {
    if (cell === null || cell === undefined) {
        return null;
    }
    if (type === 'item') {
        return cell.name.toLowerCase();
    }
    if (type === 'items') {
        return cell.length; // by how many items the cell lists
    }
    if (type === 'boolean') {
        return cell ? 1 : 0;
    }
    if (type === 'text') {
        return cell === '' ? null : cell;
    }
    return cell;
};

const uiCompareKeys = (a, b) => {
    if (typeof a === 'string' && typeof b === 'string') {
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    }
    return a - b;
};

// rows sorted by one column (a new array). Empty cells go last in either direction.
const uiSortRows = (rows, columnIndex, type, dir) => {
    const keyed = rows.map(row => ({ row, key: uiSortKey(type, row[columnIndex]) }));
    keyed.sort((a, b) => {
        if (a.key === null || b.key === null) {
            return (a.key === null) - (b.key === null);
        }
        const order = uiCompareKeys(a.key, b.key);
        return dir === 'desc' ? -order : order;
    });
    return keyed.map(entry => entry.row);
};

// --- Searching --------------------------------------------------------------------------------

// The words typed in a table's search box, lowercase. "  Dharok  helm " -> ['dharok', 'helm'].
const uiSearchTerms = (query) => query.toLowerCase().split(/\s+/).filter(Boolean);

// rows whose search text (panel.search.texts, by row index) holds every term.
const uiFilterRows = (rows, texts, terms) => {
    const matches = [];
    rows.forEach((row, index) => {
        const text = texts[index] || '';
        if (terms.every(term => text.includes(term))) {
            matches.push(row);
        }
    });
    return matches;
};

// Clicking a header: a new column sorts ascending, then descending, then back to the code's order.
// sort: { column, dir }, or { column: null } for the code's order.
const uiNextSort = (current, columnIndex) => {
    if (current.column !== columnIndex) {
        return { column: columnIndex, dir: 'asc' };
    }
    if (current.dir === 'asc') {
        return { column: columnIndex, dir: 'desc' };
    }
    return { column: null, dir: null };
};


// --- Item hover card --------------------------------------------------------------------------
// One FormulaTooltip for the whole section. Items call show(itemRef, event) on mouseenter and
// hide() on mouseleave; the card stays while the pointer is on it.

const UI_TIP_SHOW_DELAY = 300;
const UI_TIP_SWITCH_DELAY = 120;
const UI_TIP_LEAVE_DELAY = 250;

// The tip FormulaTooltip renders for an item ref under el (see the tip shape there).
const uiItemTip = (catalog, itemRef, el) => {
    const rect = el.getBoundingClientRect();
    const item = (catalog && itemRef.id !== null && catalog.byId[itemRef.id]) || null;
    return {
        target: `item:${itemRef.id}:${itemRef.name}`,
        anchor: { top: rect.top, bottom: rect.bottom, left: rect.left },
        variable: null,
        itemArg: itemRef.id === null ? itemRef.name : String(itemRef.id),
        item,
        itemTags: catalogItemTags(catalog, item),
        itemsLoaded: isCatalogLoaded(catalog),
        replaceCall: null,
    };
};

// getCatalog: () => the itemCatalog ({ byId, byName, tagsOf?, labelOf?, isUserTag? }).
const useItemHoverTip = (getCatalog) => {
    const tip = ref(null);
    let showTimer = null;
    let hideTimer = null;
    let cardHovered = false;

    const show = (itemRef, event) => {
        // currentTarget is only set while the event is being handled, so it's read now.
        const el = event.currentTarget;
        clearTimeout(hideTimer);
        clearTimeout(showTimer);
        const delay = tip.value ? UI_TIP_SWITCH_DELAY : UI_TIP_SHOW_DELAY;
        showTimer = setTimeout(() => {
            tip.value = uiItemTip(getCatalog(), itemRef, el);
        }, delay);
    };

    const hide = () => {
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            if (!cardHovered) {
                tip.value = null;
            }
        }, UI_TIP_LEAVE_DELAY);
    };

    // When the hovered element moves (a strip scrolls), the card would point at the wrong place.
    const hideNow = () => {
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        cardHovered = false;
        tip.value = null;
    };

    const enterCard = () => {
        cardHovered = true;
        clearTimeout(hideTimer);
    };

    const leaveCard = () => {
        cardHovered = false;
        hide();
    };

    onBeforeUnmount(() => {
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
    });

    return { tip, hover: { show, hide, hideNow }, enterCard, leaveCard };
};


// --- Components -------------------------------------------------------------------------------
// catalog: the itemCatalog, for live item data (icons, the hover card). hover: from useItemHoverTip.

// The live catalog item for an item ref, or null (unknown, or the item list hasn't loaded).
const uiLiveItem = (catalog, itemRef) => {
    if (!catalog || !itemRef || itemRef.id === null) {
        return null;
    }
    return catalog.byId[itemRef.id] || null;
};

// The types UiCell draws itself rather than through uiCellDisplay.
const UI_ITEM_CELL_TYPES = new Set(['item', 'items']);

// One value of any type: an item (icon and name), a list of items (a row of icons that scrolls
// sideways), or formatted text.
const UiCell = {
    components: { 'item-icon': ItemIcon },
    props: { type: String, value: null, decimals: Number, catalog: Object, hover: Object },
    setup(props) {
        const liveItem = (itemRef) => uiLiveItem(props.catalog, itemRef);
        const display = computed(() => {
            if (UI_ITEM_CELL_TYPES.has(props.type)) {
                return null;
            }
            return uiCellDisplay(props.type, props.value, props.decimals);
        });
        return { liveItem, display, UI_EMPTY_CELL, UI_ITEM_CELL_TYPES };
    },
    template: `
        <span v-if="type === 'item' && value" class="ui-item-cell"
              @mouseenter="hover.show(value, $event)" @mouseleave="hover.hide()">
            <item-icon v-if="liveItem(value)" :item="liveItem(value)" class="ui-item-cell-icon"></item-icon>
            <span v-else class="ui-item-cell-icon ui-icon-placeholder"></span>
            <span class="ui-item-cell-name">{{ value.name }}</span>
        </span>
        <span v-else-if="type === 'items' && value && value.length" class="ui-items-cell" @scroll="hover.hideNow()">
            <span v-for="(itemRef, i) in value" :key="i + ':' + itemRef.id" class="ui-items-cell-tile"
                  @mouseenter="hover.show(itemRef, $event)" @mouseleave="hover.hide()">
                <item-icon v-if="liveItem(itemRef)" :item="liveItem(itemRef)" class="ui-item-cell-icon"></item-icon>
                <span v-else class="ui-item-cell-icon ui-icon-placeholder"></span>
            </span>
        </span>
        <span v-else-if="UI_ITEM_CELL_TYPES.has(type)" class="ui-tone-muted">{{ UI_EMPTY_CELL }}</span>
        <span v-else :class="display.tone ? 'ui-tone-' + display.tone : ''" :title="display.title">{{ display.text }}</span>
    `
};

// A horizontal strip of item tiles that scrolls sideways.
const UiItemStrip = {
    components: { 'item-icon': ItemIcon },
    props: { panel: Object, catalog: Object, hover: Object },
    setup(props) {
        const liveItem = (itemRef) => uiLiveItem(props.catalog, itemRef);
        return { liveItem };
    },
    template: `
        <div v-if="!panel.items.length" class="ui-empty-note">No items.</div>
        <div v-else class="ui-item-strip" @scroll="hover.hideNow()">
            <div v-for="(itemRef, i) in panel.items" :key="i + ':' + itemRef.id"
                 class="ui-item-tile" :class="'ui-item-tile-' + panel.shape"
                 @mouseenter="hover.show(itemRef, $event)" @mouseleave="hover.hide()">
                <item-icon v-if="liveItem(itemRef)" :item="liveItem(itemRef)" class="ui-item-tile-icon"></item-icon>
                <span v-else class="ui-item-tile-icon ui-icon-placeholder"></span>
                <span v-if="panel.shape === 'portrait'" class="ui-item-tile-name">{{ itemRef.name }}</span>
            </div>
        </div>
    `
};

// A table with clickable, sortable headers, an optional search box and an optional totals row.
// The totals cover every row, not just the ones a search shows.
const UiTable = {
    components: { 'ui-cell': UiCell },
    props: { panel: Object, catalog: Object, hover: Object },
    setup(props) {
        // null until a header is clicked; until then the code's sortBy applies.
        const userSort = ref(null);
        const showAll = ref(false);
        const searchQuery = ref('');

        const sort = computed(() => userSort.value || props.panel.sort || { column: null, dir: null });

        const searchTerms = computed(() => uiSearchTerms(searchQuery.value));

        // Filtering comes before sorting, since the search texts line up with the code's row order.
        const matchingRows = computed(() => {
            const search = props.panel.search;
            if (!search || !searchTerms.value.length) {
                return props.panel.rows;
            }
            return uiFilterRows(props.panel.rows, search.texts, searchTerms.value);
        });

        const sortedRows = computed(() => {
            const { column, dir } = sort.value;
            const isSortable = column !== null && column < props.panel.columns.length;
            if (!isSortable) {
                return matchingRows.value;
            }
            return uiSortRows(matchingRows.value, column, props.panel.columns[column].type, dir);
        });

        const visibleRows = computed(() => {
            if (showAll.value) {
                return sortedRows.value;
            }
            return sortedRows.value.slice(0, UI_TABLE_PAGE_ROWS);
        });

        const clickHeader = (columnIndex) => {
            userSort.value = uiNextSort(sort.value, columnIndex);
        };

        const sortMark = (columnIndex) => {
            if (sort.value.column !== columnIndex) {
                return '';
            }
            return sort.value.dir === 'asc' ? '▲' : '▼';
        };

        // The totals row's label goes in the first column when that column has no total.
        const totalsLabelInFirst = computed(() => {
            const totals = props.panel.totals;
            return Boolean(totals) && totals[0] === null;
        });

        return {
            sort, visibleRows, matchingRows, showAll, searchQuery, searchTerms,
            clickHeader, sortMark, totalsLabelInFirst,
        };
    },
    template: `
        <div v-if="!panel.columns.length" class="ui-empty-note">No rows.</div>
        <template v-else>
            <div v-if="panel.search" class="ui-table-search">
                <input type="text" class="ui-table-search-input" v-model="searchQuery"
                       :placeholder="panel.search.placeholder" spellcheck="false"
                       @keydown.esc="searchQuery = ''">
                <span v-if="searchTerms.length" class="ui-table-search-count">
                    {{ matchingRows.length }} of {{ panel.rows.length }}
                </span>
            </div>
            <div class="ui-table-wrap">
                <table class="ui-table">
                    <thead>
                        <tr>
                            <th v-for="(column, c) in panel.columns" :key="c"
                                :class="['ui-align-' + column.align, { sorted: sort.column === c }]"
                                title="Sort by this column"
                                @click="clickHeader(c)">
                                {{ column.label }}<span class="ui-sort-mark">{{ sortMark(c) }}</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="(row, r) in visibleRows" :key="r">
                            <td v-for="(column, c) in panel.columns" :key="c" :class="'ui-align-' + column.align">
                                <ui-cell :type="column.type" :value="row[c]" :decimals="column.decimals ?? undefined"
                                         :catalog="catalog" :hover="hover"></ui-cell>
                            </td>
                        </tr>
                        <tr v-if="!panel.rows.length">
                            <td :colspan="panel.columns.length" class="ui-empty-note">No rows.</td>
                        </tr>
                        <tr v-else-if="!matchingRows.length">
                            <td :colspan="panel.columns.length" class="ui-empty-note">No rows match "{{ searchQuery.trim() }}".</td>
                        </tr>
                    </tbody>
                    <tfoot v-if="panel.totals">
                        <tr>
                            <td v-for="(column, c) in panel.columns" :key="c" :class="'ui-align-' + column.align">
                                <template v-if="panel.totals[c] !== null">
                                    <ui-cell :type="column.type" :value="panel.totals[c]" :decimals="column.decimals ?? undefined"
                                             :catalog="catalog" :hover="hover"></ui-cell>
                                </template>
                                <template v-else-if="c === 0 && totalsLabelInFirst">Total</template>
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>
            <div v-if="matchingRows.length > visibleRows.length || panel.truncatedFrom" class="ui-table-note">
                <template v-if="matchingRows.length > visibleRows.length">
                    Showing {{ visibleRows.length }} of {{ matchingRows.length }} rows.
                    <button type="button" class="ui-link-btn" @click="showAll = true">Show all</button>
                </template>
                <template v-if="panel.truncatedFrom">
                    Only the first {{ panel.rows.length.toLocaleString() }} of {{ panel.truncatedFrom.toLocaleString() }} rows were kept.
                </template>
            </div>
        </template>
    `
};

// Big-number tiles in a wrapping grid.
const UiStats = {
    components: { 'ui-cell': UiCell },
    props: { panel: Object, catalog: Object, hover: Object },
    template: `
        <div class="ui-stats">
            <div v-for="(entry, i) in panel.entries" :key="i" class="ui-stat">
                <span class="ui-stat-label">{{ entry.label }}</span>
                <span class="ui-stat-value">
                    <ui-cell :type="entry.type" :value="entry.value" :catalog="catalog" :hover="hover"></ui-cell>
                </span>
            </div>
        </div>
    `
};

// The whole UI section. panels: the run's UiPanel list. runError: the run's error, or null; the
// panels are then only the ones made before it.
const ScopeUiPanel = {
    components: {
        'formula-tooltip': FormulaTooltip,
        'ui-item-strip': UiItemStrip,
        'ui-table': UiTable,
        'ui-stats': UiStats,
    },
    props: { panels: Array, itemCatalog: Object, runError: String },
    setup(props) {
        const { tip, hover, enterCard, leaveCard } = useItemHoverTip(() => props.itemCatalog);

        const panelKey = (panel, index) => `${index}:${panel.kind}:${panel.title || ''}`;

        const togglePlacement = () => {
            editorSettings.uiInSidebar = !editorSettings.uiInSidebar;
        };

        return { tip, hover, enterCard, leaveCard, panelKey, editorSettings, togglePlacement };
    },
    template: `
        <div class="scope-panel ui-panel">
            <div class="ui-panel-head">
                <h4>UI</h4>
                <button type="button" class="ui-placement-btn"
                        :title="editorSettings.uiInSidebar ? 'Move above the editor, full width' : 'Move to the sidebar, above Values'"
                        @click="togglePlacement">
                    <!-- The layout the button moves the section to: a top band, or a right column -->
                    <svg v-if="editorSettings.uiInSidebar" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>
                    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></svg>
                    {{ editorSettings.uiInSidebar ? 'Move to top' : 'Move to sidebar' }}
                </button>
            </div>
            <div v-if="runError" class="ui-stale-note">The code stopped with an error, so only the panels made before it are shown.</div>

            <template v-for="(panel, i) in panels" :key="panelKey(panel, i)">
                <h5 v-if="panel.kind === 'heading'" class="ui-heading">{{ panel.text }}</h5>
                <p v-else-if="panel.kind === 'text'" class="ui-text">{{ panel.text }}</p>
                <section v-else class="ui-block">
                    <div v-if="panel.title" class="ui-block-title">{{ panel.title }}</div>
                    <ui-item-strip v-if="panel.kind === 'items'" :panel="panel" :catalog="itemCatalog" :hover="hover"></ui-item-strip>
                    <ui-table v-else-if="panel.kind === 'table'" :panel="panel" :catalog="itemCatalog" :hover="hover"></ui-table>
                    <ui-stats v-else-if="panel.kind === 'stats'" :panel="panel" :catalog="itemCatalog" :hover="hover"></ui-stats>
                </section>
            </template>

            <teleport to="body">
                <transition name="formula-tip">
                    <formula-tooltip v-if="tip" :tip="tip" @enter="enterCard" @leave="leaveCard"></formula-tooltip>
                </transition>
            </teleport>
        </div>
    `
};
