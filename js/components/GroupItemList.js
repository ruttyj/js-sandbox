const GroupItemList = {
    components: { 'item-icon': ItemIcon },
    props: ['selectedGroup', 'hydratedGroupItems', 'draggedItemIndex'],
    emits: ['remove-item', 'drag-start', 'drag-end', 'drop'],
    template: `
        <div class="selected-group-items">
            <div v-if="!selectedGroup" class="placeholder-message">
                <slot name="placeholder">Please select a group to view its items.</slot>
            </div>
            <div v-else>
                <div class="group-items-header">
                    <h3>{{ selectedGroup.name }}</h3>
                    <span class="count-badge">{{ selectedGroup.items.length }} items</span>
                </div>
                <div v-if="selectedGroup.items.length === 0" class="empty-state">
                    This group has no items. Go to "Market Search" to add some!
                </div>
                <div v-for="(item, index) in hydratedGroupItems"
                     :key="item.id"
                     class="group-item"
                     @dragover.prevent
                     @dragenter.prevent
                     @drop="$emit('drop', $event, index)"
                     :class="{ 'dragging': draggedItemIndex === index }">
                    <div class="group-item-top">
                        <span class="drag-handle" draggable="true" @dragstart="$emit('drag-start', $event, index)" @dragend="$emit('drag-end')" title="Drag to reorder">⋮⋮</span>
                        <item-icon :item="item" class="item-icon"></item-icon>
                        <span class="group-item-name"><a target="_blank" :href="'https://prices.osrs.cloud/item/' + item.id">{{ item.name }}</a> <span class="item-id-badge">#{{ item.id }}</span></span>
                        <button @click="$emit('remove-item', item.id)" class="remove-item-btn">Remove</button>
                    </div>
                    <div class="group-item-bottom">
                        <div class="group-item-prices">
                            <div v-if="item.highPrice" class="price-row">
                                <span class="price-label">High</span>
                                <span class="price-val-high">{{ item.highPrice.toLocaleString() }}</span>
                            </div>
                            <div v-if="item.lowPrice" class="price-row">
                                <span class="price-label">Low</span>
                                <span class="price-val-low">{{ item.lowPrice.toLocaleString() }}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `
};
