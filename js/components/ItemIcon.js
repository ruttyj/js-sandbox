// An item's icon, loaded through the icon cache once it scrolls into view.
// class/style/alt fall through to the <img>.
const ItemIcon = {
    props: { item: Object },
    setup(props) {
        const el = ref(null);
        const src = computed(() => iconSrcs[props.item.id] || BLANK_ICON_SRC);

        const observe = () => {
            if (el.value && !iconSrcs[props.item.id]) observeItemIcon(el.value, props.item);
        };

        onMounted(observe);
        watch(() => props.item.id, () => {
            if (el.value) unobserveItemIcon(el.value);
            observe();
        });
        onBeforeUnmount(() => {
            if (el.value) unobserveItemIcon(el.value);
        });

        return { el, src };
    },
    template: `<img ref="el" :src="src" :alt="item.name">`
};
