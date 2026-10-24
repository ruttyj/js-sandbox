// The command palette's commands (see CommandPalette) and the app-wide keyboard shortcuts:
// Ctrl+K or Ctrl+Shift+P opens the palette, Alt+1 to Alt+6 switch tabs, Ctrl+S saves now, and
// Ctrl+B / Ctrl+Alt+B collapse or expand the data panel / the sidebar (as in VS Code).
//
// Uses globals from scripts loaded before it:
//   composables/useEditorSettings.js  editorSettings
//   composables/useWorkbench.js       resetPaneWidth, PANE_LIMITS, paneCollapsed, togglePaneCollapsed

// The app's tabs in header order. Alt+<position> switches to one.
const APP_TABS = [
    { id: 'market', label: 'Market Search' },
    { id: 'item-tags', label: 'Item Tags' },
    { id: 'globals', label: 'Global Vars' },
    { id: 'scopes', label: 'Scopes' },
    { id: 'tags', label: 'Variable Tags' },
    { id: 'dashboard', label: 'Dashboard' },
];


// --- Commands ---------------------------------------------------------------------------------
// ctx: { activeTab, scopes, selectedScopeId, createScope, refreshPrices, exportData, saveNow,
// isAiChatAvailable, openAiChat }. isAiChatAvailable is read inside the computed list, so the
// AI command appears once the AI status has loaded.

const tabCommands = (ctx) => APP_TABS.map((tab, index) => ({
    id: `tab:${tab.id}`,
    group: 'Go to',
    label: tab.label,
    hint: `Alt+${index + 1}`,
    run: () => {
        ctx.activeTab.value = tab.id;
    },
}));

const scopeCommands = (ctx) => {
    const commands = [{
        id: 'scope:new',
        group: 'Scope',
        label: 'New scope',
        run: () => {
            ctx.activeTab.value = 'scopes';
            ctx.createScope();
        },
    }];
    for (const scope of ctx.scopes.value) {
        commands.push({
            id: `scope:open:${scope.id}`,
            group: 'Open scope',
            label: scope.name,
            run: () => {
                ctx.selectedScopeId.value = scope.id;
                ctx.activeTab.value = 'scopes';
            },
        });
    }
    return commands;
};

const toggleSettingCommand = (key, label) => ({
    id: `view:${key}`,
    group: 'View',
    label: `${editorSettings[key] ? 'Hide' : 'Show'} ${label}`,
    run: () => {
        editorSettings[key] = !editorSettings[key];
    },
});

const togglePaneCommand = (pane, label, hint) => ({
    id: `layout:toggle-${pane}`,
    group: 'Layout',
    label: `${paneCollapsed[pane] ? 'Expand' : 'Collapse'} ${label}`,
    hint,
    run: () => togglePaneCollapsed(pane),
});

const layoutCommands = () => [
    togglePaneCommand('explorer', 'the data panel', 'Ctrl+B'),
    togglePaneCommand('sidebar', 'the sidebar', 'Ctrl+Alt+B'),
    {
        id: 'layout:ui-top',
        group: 'Layout',
        label: 'Dock the UI section full width above the editor',
        run: () => {
            editorSettings.uiInSidebar = false;
        },
    },
    {
        id: 'layout:ui-sidebar',
        group: 'Layout',
        label: 'Dock the UI section in the sidebar',
        run: () => {
            editorSettings.uiInSidebar = true;
        },
    },
    {
        id: 'layout:reset-panes',
        group: 'Layout',
        label: 'Reset the pane widths',
        run: () => {
            for (const pane of Object.keys(PANE_LIMITS)) {
                resetPaneWidth(pane);
            }
        },
    },
    toggleSettingCommand('syntaxHighlight', 'syntax colors'),
    toggleSettingCommand('variableHighlight', 'variable colors'),
    toggleSettingCommand('lineNumbers', 'line numbers'),
];

const actionCommands = (ctx) => {
    const commands = [
        { id: 'action:save', group: 'Data', label: 'Save now', hint: 'Ctrl+S', run: ctx.saveNow },
        { id: 'action:refresh', group: 'Data', label: 'Refresh GE prices', run: ctx.refreshPrices },
        { id: 'action:export', group: 'Data', label: 'Export data to a file', run: ctx.exportData },
    ];
    if (ctx.isAiChatAvailable()) {
        commands.push({ id: 'action:ai', group: 'AI', label: 'Open the AI chat', run: ctx.openAiChat });
    }
    return commands;
};

const useCommandPalette = (ctx) => {
    const isCommandPaletteOpen = ref(false);

    const paletteCommands = computed(() => [
        ...tabCommands(ctx),
        ...scopeCommands(ctx),
        ...actionCommands(ctx),
        ...layoutCommands(),
    ]);

    const openCommandPalette = () => {
        isCommandPaletteOpen.value = true;
    };

    const closeCommandPalette = () => {
        isCommandPaletteOpen.value = false;
    };

    const runPaletteCommand = (command) => {
        closeCommandPalette();
        command.run();
    };

    return { isCommandPaletteOpen, paletteCommands, openCommandPalette, closeCommandPalette, runPaletteCommand };
};


// --- Keyboard shortcuts -----------------------------------------------------------------------

// Alt+1 -> 0, ..., Alt+6 -> 5; null for any other key. Uses e.code, since Alt changes e.key on
// some keyboard layouts.
const tabIndexForShortcut = (e) => {
    const isPlainAlt = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    const match = /^Digit([1-9])$/.exec(e.code);
    if (!isPlainAlt || !match) {
        return null;
    }
    const index = Number(match[1]) - 1;
    return index < APP_TABS.length ? index : null;
};

const isPaletteShortcut = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    return mod && !e.altKey && (key === 'k' || (key === 'p' && e.shiftKey));
};

// Ctrl+B -> 'explorer', Ctrl+Alt+B -> 'sidebar'; null for any other key.
const paneForShortcut = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.shiftKey || e.key.toLowerCase() !== 'b') {
        return null;
    }
    return e.altKey ? 'sidebar' : 'explorer';
};

const isSaveShortcut = (e) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's';

// shortcuts: { openCommandPalette, saveNow, activeTab }. Listens on the window while mounted.
const useGlobalShortcuts = (shortcuts) => {
    const handleKeydown = (e) => {
        if (isPaletteShortcut(e)) {
            e.preventDefault();
            shortcuts.openCommandPalette();
            return;
        }
        if (isSaveShortcut(e)) {
            e.preventDefault();
            shortcuts.saveNow();
            return;
        }

        const pane = paneForShortcut(e);
        if (pane) {
            e.preventDefault();
            togglePaneCollapsed(pane);
            return;
        }

        const tabIndex = tabIndexForShortcut(e);
        if (tabIndex !== null) {
            e.preventDefault();
            shortcuts.activeTab.value = APP_TABS[tabIndex].id;
        }
    };

    onMounted(() => window.addEventListener('keydown', handleKeydown));
    onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown));
};
