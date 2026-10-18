// Wires the composables together. Dependencies flow one way:
// toasts/modals -> store -> items -> item tags -> evaluation -> scopes -> variables -> dashboard / import-export / url.
createApp({
    components: {
        'formula-input': FormulaInput,
        'tag-multi-select': TagMultiSelect,
        'item-ref-list': ItemRefList,
        'item-icon': ItemIcon,
        'editor-view-toggles': EditorViewToggles,
    },
    setup() {
        const activeTab = ref('market');

        const toastApi = useToasts();
        const { showToast } = toastApi;
        const modalApi = useModals();

        const store = useTrackerStore({ showToast });
        const itemsApi = useRunescapeItems({ showToast });

        const itemTagsApi = useItemTags({
            store,
            items: itemsApi.items,
            itemsByName: itemsApi.itemsByName,
            showToast,
            showUndoToast: toastApi.showUndoToast,
            showConfirmModal: modalApi.showConfirmModal,
            showInputModal: modalApi.showInputModal,
        });

        const evaluation = useEvaluation({
            store,
            items: itemsApi.items,
            itemsByName: itemsApi.itemsByName,
            itemQuerySource: itemTagsApi.itemQuerySource,
        });

        const scopesApi = useScopes({
            store,
            items: itemsApi.items,
            itemsByName: itemsApi.itemsByName,
            itemTagsApi,
            evaluation,
            showToast,
            showConfirmModal: modalApi.showConfirmModal,
            showInputModal: modalApi.showInputModal,
        });

        const variablesApi = useVariables({
            store,
            items: itemsApi.items,
            itemTagsApi,
            evaluation,
            selectedScope: scopesApi.selectedScope,
            scopesApi,
            showToast,
        });

        const tagsApi = useTags({ store, showToast });

        const dashboardApi = useDashboard({
            store,
            evaluation,
            getVariableValue: variablesApi.getVariableValue,
            getGlobalVariableValue: variablesApi.getGlobalVariableValue,
        });

        const importExportApi = useImportExport({ store, showToast });

        const { initFromUrl } = useUrlState({
            isItemTag: itemTagsApi.isItemTag,
            scopes: store.scopes,
            selectedItemTagKey: itemTagsApi.selectedItemTagKey,
            selectedScopeId: scopesApi.selectedScopeId,
            activeTab,
        });

        onMounted(() => {
            store.loadSavedData();
            dashboardApi.loadDashboardFilter();
            initFromUrl();
            itemsApi.loadItems();
        });

        return {
            activeTab,
            ...toastApi,
            ...modalApi,
            ...store,
            ...itemsApi,
            ...itemTagsApi,
            ...scopesApi,
            ...variablesApi,
            ...tagsApi,
            ...dashboardApi,
            ...importExportApi,
            formatVarValue,
            formulaFunctionReference: FORMULA_FUNCTION_REFERENCE,
            // Values panels: entries are split by whether the code's `return { ... }` exposes them.
            publicEntries: (entries) => entries.filter(e => !e.private),
            privateEntries: (entries) => entries.filter(e => e.private),
        };
    }
}).mount('#app');
