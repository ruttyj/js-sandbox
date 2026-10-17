// Wires the composables together. Dependencies flow one way:
// toasts/modals -> store -> items -> groups -> evaluation -> scopes -> variables -> dashboard / import-export / url.
createApp({
    components: {
        'formula-input': FormulaInput,
        'group-item-list': GroupItemList,
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

        const groupsApi = useItemGroups({
            store,
            items: itemsApi.items,
            activeTab,
            showToast,
            showConfirmModal: modalApi.showConfirmModal,
            showInputModal: modalApi.showInputModal,
        });

        const evaluation = useEvaluation({
            store,
            items: itemsApi.items,
            itemsByName: itemsApi.itemsByName,
        });

        const scopesApi = useScopes({
            store,
            items: itemsApi.items,
            itemsByName: itemsApi.itemsByName,
            evaluation,
            showToast,
            showConfirmModal: modalApi.showConfirmModal,
            showInputModal: modalApi.showInputModal,
        });

        const variablesApi = useVariables({
            store,
            items: itemsApi.items,
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

        const importExportApi = useImportExport({
            store,
            selectedGroupId: groupsApi.selectedGroupId,
            showToast,
        });

        const { initFromUrl } = useUrlState({
            groups: store.groups,
            scopes: store.scopes,
            selectedGroupId: groupsApi.selectedGroupId,
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
            ...groupsApi,
            ...scopesApi,
            ...variablesApi,
            ...tagsApi,
            ...dashboardApi,
            ...importExportApi,
            formatVarValue,
            // Values panels: entries are split by whether the code's `return { ... }` exposes them.
            publicEntries: (entries) => entries.filter(e => !e.private),
            privateEntries: (entries) => entries.filter(e => e.private),
        };
    }
}).mount('#app');
