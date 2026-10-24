// Wires the composables together. Dependencies flow one way:
// toasts/modals -> session / store -> items -> item tags -> evaluation -> scopes -> variables ->
// AI account / AI chat -> code error toasts / tags / dashboard / import-export / sharing / url.

// How the header shows the store's saveStatus; a missing entry ('loading') hides it.
const SAVE_STATUS_PILLS = {
    saved: { label: 'Saved', className: 'is-live', title: 'All changes are saved.' },
    pending: { label: 'Unsaved', className: 'is-loading', title: 'Saving once you stop editing.' },
    saving: { label: 'Saving', className: 'is-loading', title: 'Saving your changes.' },
    error: { label: 'Not saved', className: 'is-error', title: "Couldn't reach the server; trying again shortly." },
    conflict: { label: 'Conflict', className: 'is-error', title: 'Changed somewhere else; see the banner.' },
    'signed-out': { label: 'Signed out', className: 'is-error', title: 'Sign in again to keep saving.' },
    readonly: { label: 'Read-only', className: 'is-loading', title: 'A shared scope: nothing is saved.' },
};

// On a share link, the shared scope; otherwise the signed-in user's data (signed out: nothing).
// Returns whether anything was loaded.
const loadAppData = async ({ store, sessionApi, sharingApi, activeTab, showToast }) => {
    try {
        if (sharingApi.isSharedView) {
            await store.loadSharedScope(sharingApi.sharedViewToken);
            activeTab.value = 'scopes';
            return true;
        }
        if (sessionApi.currentUser.value) {
            await store.loadSavedData();
            return true;
        }
        return false;
    } catch (error) {
        console.error(error);
        const isRevokedShare = sharingApi.isSharedView && error.status === 404;
        showToast(isRevokedShare ? 'This link is no longer shared.' : 'Could not load your data.', 'error');
        return false;
    }
};

createApp({
    components: {
        'formula-input': FormulaInput,
        'tag-multi-select': TagMultiSelect,
        'item-ref-list': ItemRefList,
        'item-icon': ItemIcon,
        'editor-insert-menu': EditorInsertMenu,
        'editor-view-menu': EditorViewMenu,
        'scope-ui-panel': ScopeUiPanel,
    },
    setup() {
        const activeTab = ref('market');

        const toastApi = useToasts();
        const { showToast } = toastApi;
        const modalApi = useModals();

        const sessionApi = useSession({ showToast });
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

        const aiAccountApi = useAiAccount({ showToast });

        const agentChatApi = useAgentChat({
            store,
            itemTagsApi,
            evaluation,
            scopesApi,
            variablesApi,
            aiAccountApi,
            activeTab,
            showToast,
            showUndoToast: toastApi.showUndoToast,
            showConfirmModal: modalApi.showConfirmModal,
        });

        useCodeErrorToasts({
            activeTab,
            editors: {
                globals: {
                    label: () => 'globals.js',
                    errors: variablesApi.globalsCodeErrors,
                    editorRef: variablesApi.globalsCodeEditorRef,
                },
                scopes: {
                    label: () => scopesApi.selectedScope.value?.name || 'Scope',
                    errors: scopesApi.scopeCodeErrors,
                    editorRef: scopesApi.scopeCodeEditorRef,
                },
            },
            showStickyToast: toastApi.showStickyToast,
            dismissStickyToast: toastApi.dismissStickyToast,
            fixWithAssistant: {
                isAvailable: () => aiAccountApi.aiStatus.value.connected,
                name: () => aiAccountApi.assistantName.value,
                ask: agentChatApi.askAssistantToFix,
            },
        });

        const tagsApi = useTags({ store, showToast });

        const dashboardApi = useDashboard({
            store,
            evaluation,
            getVariableValue: variablesApi.getVariableValue,
            getGlobalVariableValue: variablesApi.getGlobalVariableValue,
        });

        const importExportApi = useImportExport({ store, showToast });

        const sharingApi = useSharing({
            selectedScope: scopesApi.selectedScope,
            flushPendingSaves: store.flushPendingSaves,
            showToast,
            showConfirmModal: modalApi.showConfirmModal,
            showInputModal: modalApi.showInputModal,
        });

        const showSignInScreen = computed(() => sessionApi.sessionChecked.value
            && !sessionApi.currentUser.value
            && !sharingApi.isSharedView);
        const saveStatusPill = computed(() => SAVE_STATUS_PILLS[store.saveStatus.value] || null);
        const signOutOfApp = () => sessionApi.signOut(store.flushPendingSaves);

        const { initFromUrl } = useUrlState({
            isItemTag: itemTagsApi.isItemTag,
            scopes: store.scopes,
            selectedItemTagKey: itemTagsApi.selectedItemTagKey,
            selectedScopeId: scopesApi.selectedScopeId,
            activeTab,
        });

        onMounted(async () => {
            itemsApi.loadItems();
            sessionApi.reportFailedSignIn();
            await sessionApi.loadSession();
            const loaded = await loadAppData({ store, sessionApi, sharingApi, activeTab, showToast });
            if (loaded) {
                initFromUrl();
            }
            if (sessionApi.currentUser.value && !sharingApi.isSharedView) {
                aiAccountApi.loadAiStatus();
            }
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
            ...sessionApi,
            ...sharingApi,
            ...aiAccountApi,
            ...agentChatApi,
            showSignInScreen,
            saveStatusPill,
            signOutOfApp,
            formatVarValue,
            editorSettings,
            formulaFunctionReference: FORMULA_FUNCTION_REFERENCE,
            // Values panels: entries are split by whether the code's `return { ... }` exposes them.
            publicEntries: (entries) => entries.filter(e => !e.private),
            privateEntries: (entries) => entries.filter(e => e.private),
        };
    }
}).mount('#app');
