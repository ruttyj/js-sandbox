const useToasts = () => {
    const toasts = ref([]);

    const showToast = (message, type = 'info', duration = 3000) => {
        const id = Date.now() + Math.random();
        toasts.value.push({ id, message, type });
        setTimeout(() => {
            toasts.value = toasts.value.filter(t => t.id !== id);
        }, duration);
    };

    return { toasts, showToast };
};
