// Item group CRUD, item membership, and drag-reordering of groups and their items.
// A group is just a list of items; scopes reference groups as short lists to draw from.
const useItemGroups = ({ store, items, activeTab, showToast, showConfirmModal, showInputModal }) => {
    const { groups, scopes, saveData } = store;

    const groupSearchText = ref('');
    const selectedGroupId = ref(null);
    const newGroupName = ref('');
    const draggedItemIndex = ref(null);
    const draggedGroupIndex = ref(null);

    const selectedGroup = computed(() => groups.value.find(g => g.id === selectedGroupId.value));

    const filteredGroups = computed(() => {
        if (!groupSearchText.value) return groups.value;
        const lower = groupSearchText.value.toLowerCase();
        return groups.value.filter(g => g.name.toLowerCase().includes(lower));
    });

    const hydratedGroupItems = computed(() => {
        if (!selectedGroup.value) return [];
        return hydrateGroupItems(selectedGroup.value.items, items.value);
    });

    const createGroup = () => {
        if (!newGroupName.value.trim()) return;
        const newGroup = {
            id: Date.now(),
            name: newGroupName.value.trim(),
            items: []
        };
        groups.value.push(newGroup);
        newGroupName.value = '';
        saveData();
        showToast(`Group "${newGroup.name}" created.`, 'success');
    };

    const renameGroup = (groupId) => {
        const group = groups.value.find(g => g.id === groupId);
        if (!group) return;

        showInputModal('Rename Group', group.name, (newName) => {
            if (newName && newName.trim()) {
                group.name = newName.trim();
                saveData();
                showToast(`Group renamed to "${group.name}".`, 'success');
            }
        });
    };

    const deleteGroup = (groupId) => {
        const group = groups.value.find(g => g.id === groupId);
        if (!group) return;

        const usedBy = scopes.value.filter(s => s.groupIds.includes(String(groupId)));
        const usedByNote = usedBy.length
            ? `<br>It will be removed from ${usedBy.length} scope(s) that reference it; their code is kept.`
            : '';

        showConfirmModal(
            'Delete Group',
            `Are you sure you want to delete the group "<strong>${group.name}</strong>"?${usedByNote}`,
            () => {
                groups.value = groups.value.filter(g => g.id !== groupId);
                usedBy.forEach(s => { s.groupIds = s.groupIds.filter(id => id !== String(groupId)); });
                if (selectedGroupId.value === groupId) selectedGroupId.value = null;
                saveData();
                showToast(`Group "${group.name}" deleted.`, 'success');
            }
        );
    };

    const selectGroup = (groupId) => {
        selectedGroupId.value = groupId;
        // Jump from the market to the group so the click has a visible effect.
        if (activeTab.value === 'market') activeTab.value = 'group-items';
    };

    const switchToGroupTab = (tab) => {
        if (!selectedGroup.value) {
            showToast("Please select a group first.", "info");
            return;
        }
        activeTab.value = tab;
    };

    const addItemToSelectedGroup = (item) => {
        if (!selectedGroup.value) {
            showToast('Please select a group first!', 'info');
            return;
        }
        if (selectedGroup.value.items.some(i => i.id === item.id)) {
            showToast(`${item.name} is already in this group.`, 'info');
            return;
        }
        selectedGroup.value.items.push({
            id: item.id,
            color: getRandomVibrantColor(),
            order: selectedGroup.value.items.length
        });
        saveData();
        showToast(`${item.name} added to ${selectedGroup.value.name}.`, 'success');
    };

    const removeItemFromGroup = (itemId) => {
        if (!selectedGroup.value) return;
        selectedGroup.value.items = selectedGroup.value.items.filter(i => i.id !== itemId);
        saveData();
    };

    // Writes an item's color from the hydrated copy back to the stored item.
    const setItemColor = (itemId, color) => {
        const stored = selectedGroup.value?.items.find(i => i.id === itemId);
        if (!stored) return;
        stored.color = color;
        saveData();
    };

    // Drag & drop: items within the selected group
    const onDragStart = (event, index) => {
        draggedItemIndex.value = index;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', index);
    };

    const onDrop = (event, targetIndex) => {
        const sourceIndex = draggedItemIndex.value;
        draggedItemIndex.value = null;
        if (sourceIndex === null || sourceIndex === targetIndex) return;

        const reordered = moveItem(selectedGroup.value.items, sourceIndex, targetIndex);
        reordered.forEach((item, index) => { item.order = index; });
        selectedGroup.value.items = reordered;
        saveData();
    };

    // Drag & drop: the group list
    const onGroupDragStart = (event, index) => {
        draggedGroupIndex.value = index;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', index);
        event.dataTransfer.setData('type', 'group');
    };

    const onGroupDrop = (event, targetIndex) => {
        if (event.dataTransfer.getData('type') !== 'group') return;
        const sourceIndex = draggedGroupIndex.value;
        draggedGroupIndex.value = null;
        if (sourceIndex === null || sourceIndex === targetIndex) return;

        groups.value = moveItem(groups.value, sourceIndex, targetIndex);
        saveData();
    };

    return {
        groupSearchText, selectedGroupId, newGroupName,
        selectedGroup, filteredGroups, hydratedGroupItems,
        createGroup, renameGroup, deleteGroup, selectGroup, switchToGroupTab,
        addItemToSelectedGroup, removeItemFromGroup, setItemColor,
        draggedItemIndex, onDragStart, onDrop,
        draggedGroupIndex, onGroupDragStart, onGroupDrop,
    };
};
