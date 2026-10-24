const useTags = ({ store, showToast }) => {
    const { tags, saveData } = store;
    const newTagKey = ref('');
    const newTagLabel = ref('');

    const addTag = () => {
        if (!newTagKey.value.trim()) {
            showToast("Tag key cannot be empty.", "error");
            return;
        }
        const key = newTagKey.value.trim().toUpperCase();
        if (tags.value.some(t => t.key === key)) {
            showToast("Tag key must be unique.", "error");
            return;
        }
        tags.value.push({ key, label: newTagLabel.value.trim() || key });
        newTagKey.value = '';
        newTagLabel.value = '';
        saveData();
        showToast(`Tag "${key}" created.`, 'success');
    };

    const deleteTag = (index) => {
        const tag = tags.value[index];
        tags.value.splice(index, 1);
        saveData();
        showToast(`Tag "${tag.key}" deleted.`, 'success');
    };

    return { newTagKey, newTagLabel, addTag, deleteTag };
};
