// A group's items shown as the code that reads them: icon, getOsrsItem('Name'), the item ID, a
// copy button, and RS-formatted prices that insert `.highPrice` / `.lowPrice` refs when clicked.
// editable: show drag handles and color pickers (emitting drag-* / set-color).
const ItemRefList = {
    components: { 'item-icon': ItemIcon },
    props: { items: Array, draggedItemIndex: Number, editable: Boolean },
    emits: ['insert', 'copy', 'set-color', 'drag-start', 'drag-end', 'drop'],
    setup() {
        const formatPrice = (price) => (price ? formatRSNumber(price) : '—');
        const exactPrice = (price) => (price ? price.toLocaleString() : 'no price');
        return { formatPrice, exactPrice, quoteItemName };
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
                <code class="item-ref-code" :style="{ backgroundColor: item.color + '30', boxShadow: '0 0 0 1px ' + item.color + '80' }"><span class="code-fn">getOsrsItem</span>(<a class="code-string" target="_blank" :href="'https://prices.osrs.cloud/item/' + item.id" title="Open price history">{{ quoteItemName(item.name) }}</a>)</code>
                <span class="item-ref-id" title="Item ID">#{{ item.id }}</span>
                <button class="item-ref-copy" @click="$emit('copy', item)" title="Copy getOsrsItem(...)">⧉</button>
                <a class="item-ref-copy item-ref-graph" target="_blank" rel="noopener" :href="'https://prices.osrs.cloud/item/' + item.id" title="Open the price graph">📈</a>
                <span class="item-ref-prices">
                    <span class="item-ref-price price-clickable" @mousedown.prevent="$emit('insert', item.id, 'HIGH')" :title="'Insert .highPrice (' + exactPrice(item.highPrice) + ')'">
                        <span class="code-prop">.highPrice</span> <span class="price-val-high">{{ formatPrice(item.highPrice) }}</span>
                    </span>
                    <span class="item-ref-price price-clickable" @mousedown.prevent="$emit('insert', item.id, 'LOW')" :title="'Insert .lowPrice (' + exactPrice(item.lowPrice) + ')'">
                        <span class="code-prop">.lowPrice</span> <span class="price-val-low">{{ formatPrice(item.lowPrice) }}</span>
                    </span>
                </span>
            </div>
        </div>
    `
};
