// The hover card FormulaInput shows over a variable or a getOsrsItem(...) call.
//
// tip (built by FormulaInput, see buildTip there):
//   anchor      { top, bottom, left }: the hovered text's box, in viewport pixels
//   variable    { key, name, tags, color, value, hasValue } for a variable, else null
//   itemArg     the getOsrsItem argument (a name or an ID as text) when the tip is about an item
//   item        the GE item itemArg finds, or null (unknown, or the item list hasn't loaded)
//   itemTags    [{ key, label, user }]: the item's own tags (user: one of the user's own)
//   itemsLoaded whether the item list has loaded, to tell "unknown" from "loading"
//   replaceCall { start, end, text }: the getOsrsItem('Name') call in the code the card can
//               rewrite as a lookup by ID, or null (read-only code, or already by ID)
//
// colorEditable: the variable's swatch is a color picker. The parent owns the timers that show
// and hide the card, and the code, so pointer, picker and replace events are passed up as emits.

// Space kept between the card and the hovered text, and between the card and the window edge.
// The gap is kept small because the pointer has to cross it to reach the card.
const TOOLTIP_GAP = 2;
const TOOLTIP_EDGE_MARGIN = 8;
const COPIED_FEEDBACK_MS = 1200;
const PRICE_GRAPH_URL = 'https://prices.osrs.cloud/item/';

// --- Positioning ------------------------------------------------------------------------------

// Below the anchor, or above it when there's no room below; shifted left to stay on screen.
const tooltipPosition = (anchor, width, height) => {
    const maxLeft = window.innerWidth - width - TOOLTIP_EDGE_MARGIN;
    const left = Math.max(TOOLTIP_EDGE_MARGIN, Math.min(anchor.left, maxLeft));

    let top = anchor.bottom + TOOLTIP_GAP;
    const fitsBelow = top + height <= window.innerHeight - TOOLTIP_EDGE_MARGIN;
    const fitsAbove = anchor.top - TOOLTIP_GAP - height >= TOOLTIP_EDGE_MARGIN;
    if (!fitsBelow && fitsAbove) {
        top = anchor.top - TOOLTIP_GAP - height;
    }
    return { top, left };
};

// --- Formatting -------------------------------------------------------------------------------

const tooltipPrice = (price) => {
    if (!price) {
        return '—';
    }
    return formatRSNumber(price);
};

const tooltipExactNumber = (number) => {
    if (typeof number !== 'number') {
        return '';
    }
    return number.toLocaleString();
};

// The details shown under an item's prices, skipping ones the item list doesn't have.
// Returns [{ label, value, title }].
const itemDetailRows = (item) => {
    const rows = [];
    const spread = itemSpread(item);
    if (spread !== null) {
        rows.push({ label: 'Spread', value: formatRSNumber(spread), title: tooltipExactNumber(spread) });
    }
    if (item.limit) {
        rows.push({ label: 'Buy limit', value: tooltipExactNumber(item.limit), title: 'Per 4 hours' });
    }
    if (item.highalch) {
        rows.push({ label: 'High alch', value: formatRSNumber(item.highalch), title: tooltipExactNumber(item.highalch) });
    }
    if (item.value) {
        rows.push({ label: 'Store value', value: formatRSNumber(item.value), title: tooltipExactNumber(item.value) });
    }
    return rows;
};

// --- Component --------------------------------------------------------------------------------

const FormulaTooltip = {
    components: { 'item-icon': ItemIcon },
    props: { tip: Object, colorEditable: Boolean },
    emits: ['enter', 'leave', 'color-input', 'picker-open', 'picker-closed', 'replace-call'],
    setup(props) {
        const cardRef = ref(null);
        const position = ref({ top: 0, left: 0 });
        const copiedText = ref(null);
        let copiedTimer = null;

        // The card is measured once it has rendered, so it can be kept inside the window.
        const placeCard = () => {
            if (!cardRef.value || !props.tip) {
                return;
            }
            const { offsetWidth, offsetHeight } = cardRef.value;
            position.value = tooltipPosition(props.tip.anchor, offsetWidth, offsetHeight);
        };

        watch(() => [props.tip?.anchor, props.tip?.item], placeCard, { flush: 'post' });
        onMounted(placeCard);
        onBeforeUnmount(() => clearTimeout(copiedTimer));

        const copy = async (text) => {
            try {
                await navigator.clipboard.writeText(text);
            } catch (e) {
                return;
            }
            copiedText.value = text;
            clearTimeout(copiedTimer);
            copiedTimer = setTimeout(() => {
                copiedText.value = null;
            }, COPIED_FEEDBACK_MS);
        };

        const variable = computed(() => props.tip?.variable || null);
        const item = computed(() => props.tip?.item || null);
        const isItemTip = computed(() => Boolean(props.tip?.itemArg));
        const lookupById = computed(() => (item.value ? `${ITEM_LOOKUP_FN}(${item.value.id})` : ''));
        const detailRows = computed(() => (item.value ? itemDetailRows(item.value) : []));

        const valueText = computed(() => {
            if (!variable.value || !variable.value.hasValue) {
                return '';
            }
            return formatVarValue(variable.value.value);
        });
        const valueIsError = computed(() => isErrorValue(variable.value?.value));
        const valueExact = computed(() => tooltipExactNumber(variable.value?.value));

        return {
            cardRef, position, copiedText, copy,
            variable, item, isItemTip, lookupById, detailRows,
            valueText, valueIsError, valueExact,
            tooltipPrice, tooltipExactNumber, PRICE_GRAPH_URL,
        };
    },
    template: `
        <div
            ref="cardRef"
            class="formula-tip"
            :style="{ top: position.top + 'px', left: position.left + 'px' }"
            @mouseenter="$emit('enter')"
            @mouseleave="$emit('leave')"
        >
            <div v-if="variable" class="formula-tip-head">
                <input
                    v-if="colorEditable"
                    type="color"
                    class="color-picker-input formula-tip-swatch"
                    :value="variable.color"
                    :title="'Color of ' + variable.key"
                    @click="$emit('picker-open')"
                    @input="$emit('color-input', $event.target.value)"
                    @change="$emit('picker-closed')"
                    @blur="$emit('picker-closed')"
                >
                <span v-else class="formula-tip-swatch formula-tip-swatch-static" :style="{ backgroundColor: variable.color }"></span>
                <div class="formula-tip-title">
                    <span class="formula-tip-key">{{ variable.key }}</span>
                    <span v-if="variable.name" class="formula-tip-name">{{ variable.name }}</span>
                </div>
                <div v-if="variable.tags && variable.tags.length" class="formula-tip-tags">
                    <span v-for="tag in variable.tags" :key="tag" class="formula-tip-tag">{{ tag }}</span>
                </div>
            </div>

            <template v-if="isItemTip">
                <div v-if="item" class="formula-tip-item">
                    <div class="formula-tip-item-head">
                        <item-icon :item="item" class="formula-tip-icon"></item-icon>
                        <div class="formula-tip-title">
                            <span class="formula-tip-item-name">
                                {{ item.name }}
                                <span v-if="item.members" class="formula-tip-badge" title="Members item">P2P</span>
                            </span>
                            <button
                                class="formula-tip-id"
                                :class="{ copied: copiedText === String(item.id) }"
                                title="Copy the item ID"
                                @click="copy(String(item.id))"
                            >
                                <span>#{{ item.id }}</span>
                                <svg v-if="copiedText === String(item.id)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>
                                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>
                            </button>
                        </div>
                        <a class="formula-tip-graph" target="_blank" rel="noopener" :href="PRICE_GRAPH_URL + item.id" title="Open the price graph">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-5 4 4 8-9"/><path d="M15 7h5v5"/></svg>
                        </a>
                    </div>

                    <div class="formula-tip-prices">
                        <div class="formula-tip-price">
                            <span class="formula-tip-label">Low <span class="formula-tip-hint">· instant sell</span></span>
                            <span class="price-val-low formula-tip-price-value">{{ tooltipPrice(item.lowPrice) }}</span>
                            <span class="formula-tip-exact">{{ tooltipExactNumber(item.lowPrice) }}</span>
                        </div>
                        <div class="formula-tip-price">
                            <span class="formula-tip-label">High <span class="formula-tip-hint">· instant buy</span></span>
                            <span class="price-val-high formula-tip-price-value">{{ tooltipPrice(item.highPrice) }}</span>
                            <span class="formula-tip-exact">{{ tooltipExactNumber(item.highPrice) }}</span>
                        </div>
                    </div>

                    <dl v-if="detailRows.length" class="formula-tip-details">
                        <template v-for="row in detailRows" :key="row.label">
                            <dt>{{ row.label }}</dt>
                            <dd :title="row.title">{{ row.value }}</dd>
                        </template>
                    </dl>

                    <div v-if="tip.itemTags && tip.itemTags.length" class="formula-tip-item-tags">
                        <span v-for="tag in tip.itemTags" :key="tag.key" class="item-tag-chip" :class="tag.user ? 'user' : 'system'" :title="tag.key">{{ tag.label }}</span>
                    </div>

                    <p v-if="item.examine" class="formula-tip-examine">{{ item.examine }}</p>

                    <button
                        v-if="tip.replaceCall"
                        class="formula-tip-copy-lookup formula-tip-replace-lookup"
                        :title="'Replace ' + tip.replaceCall.text + ' in the code; a lookup by ID keeps working if the item is renamed'"
                        @click="$emit('replace-call', lookupById)"
                    >
                        <span>Replace with</span>
                        <code>{{ lookupById }}</code>
                    </button>
                    <button
                        v-else
                        class="formula-tip-copy-lookup"
                        :class="{ copied: copiedText === lookupById }"
                        title="Copy a lookup by ID, which keeps working if the item is renamed"
                        @click="copy(lookupById)"
                    >
                        <span v-if="copiedText === lookupById">Copied</span>
                        <span v-else>Copy</span>
                        <code>{{ lookupById }}</code>
                    </button>
                </div>
                <div v-else-if="!tip.itemsLoaded" class="formula-tip-note">Loading item data…</div>
                <div v-else class="formula-tip-note formula-tip-warning">No GE item matches <code>{{ tip.itemArg }}</code></div>
            </template>

            <div v-else-if="valueText" class="formula-tip-value" :class="{ error: valueIsError }">
                <span class="formula-tip-label">Value</span>
                <pre :title="valueExact">{{ valueText }}</pre>
            </div>
        </div>
    `
};
