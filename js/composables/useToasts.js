// Short messages in the corner. A toast can carry one action button (e.g. Undo); toasts with
// an action stay up longer so there's time to use it.
const UNDO_TOAST_DURATION = 8000;

const useToasts = () => {
    const toasts = ref([]);

    const dismissToast = (id) => {
        toasts.value = toasts.value.filter(t => t.id !== id);
    };

    // action: { label, run } for a button on the toast, or null.
    const showToast = (message, type = 'info', duration = 3000, action = null) => {
        const id = Date.now() + Math.random();
        toasts.value.push({ id, message, type, action });
        setTimeout(() => dismissToast(id), duration);
    };

    // A success toast with an Undo button that runs undo (once).
    const showUndoToast = (message, undo) => {
        showToast(message, 'success', UNDO_TOAST_DURATION, { label: 'Undo', run: undo });
    };

    const runToastAction = (toast) => {
        dismissToast(toast.id);
        toast.action.run();
    };

    return { toasts, showToast, showUndoToast, runToastAction };
};
