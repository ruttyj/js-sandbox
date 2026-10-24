// Short messages in the corner. A toast can carry one action button (e.g. Undo); toasts with
// an action stay up longer so there's time to use it.
// A sticky toast stays up until it's closed (its × button) or dismissed by its key; there's one
// per key, and showing another with the same key updates it in place instead of stacking.
const UNDO_TOAST_DURATION = 8000;

const useToasts = () => {
    const toasts = ref([]);

    const dismissToast = (id) => {
        toasts.value = toasts.value.filter(t => t.id !== id);
    };

    // action: { label, run } for a button on the toast, or null.
    const showToast = (message, type = 'info', duration = 3000, action = null) => {
        const id = Date.now() + Math.random();
        toasts.value.push({ id, message, type, action, sticky: false });
        setTimeout(() => dismissToast(id), duration);
    };

    // A success toast with an Undo button that runs undo (once).
    const showUndoToast = (message, undo) => {
        showToast(message, 'success', UNDO_TOAST_DURATION, { label: 'Undo', run: undo });
    };

    /**
     * Shows the sticky toast for key, or updates the one already showing.
     * @param {string} key
     * @param {string} message
     * @param {Object} [options]
     * @param {string} [options.type] 'error' (the default), 'info' or 'success'.
     * @param {{ label: string, run: function }|null} [options.action] A button that leaves the
     *     toast up when used.
     * @param {{ label: string, run: function }|null} [options.secondaryAction] A second button,
     *     which also leaves the toast up.
     * @param {(function(): void)|null} [options.onClose] Called when the user closes it.
     */
    const showStickyToast = (key, message, { type = 'error', action = null, secondaryAction = null, onClose = null } = {}) => {
        const fields = { message, type, action, secondaryAction, onClose };
        const existing = toasts.value.find(t => t.sticky && t.key === key);
        if (existing) {
            Object.assign(existing, fields);
            return;
        }

        const id = Date.now() + Math.random();
        toasts.value.push({ id, key, sticky: true, ...fields });
    };

    const dismissStickyToast = (key) => {
        toasts.value = toasts.value.filter(t => !(t.sticky && t.key === key));
    };

    const closeToast = (toast) => {
        dismissToast(toast.id);
        if (toast.onClose) {
            toast.onClose();
        }
    };

    // A sticky toast stays up, so its action can be used again (e.g. Go to line).
    const runToastAction = (toast) => {
        if (!toast.sticky) {
            dismissToast(toast.id);
        }
        toast.action.run();
    };

    // Only sticky toasts have one (see showStickyToast).
    const runToastSecondaryAction = (toast) => {
        toast.secondaryAction.run();
    };

    return { toasts, showToast, showUndoToast, showStickyToast, dismissStickyToast, closeToast, runToastAction, runToastSecondaryAction };
};
