// Confirm and text-input modals driven by callbacks, so callers don't own modal state.
const useModals = () => {
    // Confirm
    const isConfirmModalVisible = ref(false);
    const confirmModalTitle = ref('');
    const confirmModalMessage = ref('');
    const confirmAction = ref(null);

    const showConfirmModal = (title, message, onConfirm) => {
        confirmModalTitle.value = title;
        confirmModalMessage.value = message;
        confirmAction.value = onConfirm;
        isConfirmModalVisible.value = true;
    };

    const cancelConfirm = () => {
        isConfirmModalVisible.value = false;
        confirmModalTitle.value = '';
        confirmModalMessage.value = '';
        confirmAction.value = null;
    };

    const executeConfirm = () => {
        if (confirmAction.value) confirmAction.value();
        cancelConfirm();
    };

    // Input
    const isInputModalVisible = ref(false);
    const inputModalTitle = ref('');
    const inputModalValue = ref('');
    const inputAction = ref(null);
    const inputModalRef = ref(null);

    const showInputModal = (title, initialValue, onSave) => {
        inputModalTitle.value = title;
        inputModalValue.value = initialValue;
        inputAction.value = onSave;
        isInputModalVisible.value = true;
        nextTick(() => inputModalRef.value?.focus());
    };

    const cancelInput = () => {
        isInputModalVisible.value = false;
        inputModalTitle.value = '';
        inputModalValue.value = '';
        inputAction.value = null;
    };

    const executeInput = () => {
        if (inputAction.value) inputAction.value(inputModalValue.value);
        cancelInput();
    };

    return {
        isConfirmModalVisible, confirmModalTitle, confirmModalMessage,
        showConfirmModal, executeConfirm, cancelConfirm,
        isInputModalVisible, inputModalTitle, inputModalValue, inputModalRef,
        showInputModal, executeInput, cancelInput,
    };
};
