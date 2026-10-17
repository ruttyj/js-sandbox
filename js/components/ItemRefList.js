// A group's items shown as the code that reads them: icon, getOsrsItem('Name'), the item ID, a
// price graph link, and an RS-formatted "low - high" price range.
// Clicking the getOsrsItem(...) chip or the ID emits `copy` with that text; clicking a price
// emits `insert` for its `.lowPrice` / `.highPrice` ref.
// editable: show drag handles and color pickers (emitting drag-* / set-color).
const ItemRefList = {
    components: { 'item-icon': ItemIcon },
    props: { items: Array, draggedItemIndex: Number, editable: Boolean },
    emits: ['insert', 'copy', 'set-color', 'drag-start', 'drag-end', 'drop'],
    setup() {
        const formatPrice = (price) => (price ? formatRSNumber(price) : '—');
        const exactPrice = (price) => (price ? price.toLocaleString() : 'no price');
        return { formatPrice, exactPrice, quoteItemName, buildItemLookup };
    },
    template: `
        <div class="item-ref-list">
            <div v-for="(item, index) in items" :key="item.id"
                 class="item-ref-row"
                 :class="{ dragging: editable && draggedItemIndex === index }"
                 @dragover.prevent
                 @dragenter.prevent
                 @drop="editable && $emit('drop', $event, index)">
                <template v-if="editable">
                    <span class="drag-handle" draggable="true" @dragstart="$emit('drag-start', $event, index)" @dragend="$emit('drag-end')" title="Drag to reorder">⋮⋮</span>
                    <input type="color" :value="item.color" class="color-picker-input" title="Item color" @input="$emit('set-color', item.id, $event.target.value)">
                </template>
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
                <span class="item-ref-prices">
                    <span class="item-ref-price price-clickable price-val-low" @mousedown.prevent="$emit('insert', item.id, 'LOW')" :title="'Insert .lowPrice (' + exactPrice(item.lowPrice) + ')'">{{ formatPrice(item.lowPrice) }}</span>
                    <span class="item-ref-price-sep">–</span>
                    <span class="item-ref-price price-clickable price-val-high" @mousedown.prevent="$emit('insert', item.id, 'HIGH')" :title="'Insert .highPrice (' + exactPrice(item.highPrice) + ')'">{{ formatPrice(item.highPrice) }}</span>
                </span>
            </div>
        </div>
    `
};
