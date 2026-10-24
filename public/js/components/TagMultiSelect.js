const TagMultiSelect = {
    // modelValue: string[], options: {key, label}[]. hideKeys: list options by label only (for
    // keys that are opaque ids, e.g. item groups).
    props: { modelValue: Array, options: Array, placeholder: { type: String, default: '+ Tag' }, hideKeys: Boolean },
    emits: ['update:modelValue'],
    setup(props, { emit }) {
        const isOpen = ref(false);
        const search = ref('');
        const containerRef = ref(null);

        const filteredOptions = computed(() => {
            const s = search.value.toLowerCase();
            return props.options.filter(opt =>
                !props.modelValue.includes(opt.key) &&
                (opt.key.toLowerCase().includes(s) || opt.label.toLowerCase().includes(s))
            );
        });

        const labelFor = (key) => props.options.find(o => o.key === key)?.label || key;

        const addTag = (key) => {
            emit('update:modelValue', [...props.modelValue, key]);
            search.value = '';
        };

        const removeTag = (key) => {
            emit('update:modelValue', props.modelValue.filter(k => k !== key));
        };

        const onDocumentClick = (e) => {
            if (containerRef.value && !containerRef.value.contains(e.target)) {
                isOpen.value = false;
            }
        };
        onMounted(() => document.addEventListener('click', onDocumentClick));
        onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick));

        return { isOpen, search, filteredOptions, labelFor, addTag, removeTag, containerRef };
    },
    template: `
        <div class="tag-multi-select" ref="containerRef">
            <div class="tag-input-area" @click="isOpen = true">
                <span v-for="key in modelValue" :key="key" class="tag-pill-sm">
                    {{ labelFor(key) }}
                    <span @click.stop="removeTag(key)" class="tag-remove">×</span>
                </span>
                <input v-model="search" class="tag-search-input" :placeholder="placeholder" @focus="isOpen = true">
            </div>
            <div v-if="isOpen && filteredOptions.length > 0" class="tag-dropdown">
                <div v-for="opt in filteredOptions" :key="opt.key" class="tag-option" @click="addTag(opt.key)">
                    {{ opt.label }}<template v-if="!hideKeys"> ({{ opt.key }})</template>
                </div>
            </div>
        </div>
    `
};
