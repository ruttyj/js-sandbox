// The dropdown menus in the toolbar above a code editor:
//   EditorInsertMenu  inserts a ready-made snippet of code (emits insert(snippet); the parent
//                     owns the code, see insertSnippetIntoCodeEditor in useScopes.js)
//   EditorViewMenu    checkboxes for how code editors are shown (see editorSettings)
//
// Sections: dropdown behaviour -> snippets -> components.


// --- Dropdown behaviour -----------------------------------------------------------------------

// Open / close state for a dropdown whose root element is containerRef. A click outside it or
// Escape closes it.
const useDropdownMenu = () => {
    const isOpen = ref(false);
    const containerRef = ref(null);

    const close = () => {
        isOpen.value = false;
    };

    const toggle = () => {
        isOpen.value = !isOpen.value;
    };

    const onDocumentClick = (e) => {
        const clickedInside = containerRef.value && containerRef.value.contains(e.target);
        if (!clickedInside) {
            close();
        }
    };

    const onDocumentKeydown = (e) => {
        if (e.key === 'Escape') {
            close();
        }
    };

    onMounted(() => {
        document.addEventListener('click', onDocumentClick);
        document.addEventListener('keydown', onDocumentKeydown);
    });
    onBeforeUnmount(() => {
        document.removeEventListener('click', onDocumentClick);
        document.removeEventListener('keydown', onDocumentKeydown);
    });

    return { isOpen, containerRef, close, toggle };
};


// --- Snippets ---------------------------------------------------------------------------------
// Each snippet: { label, code, select?, scopeOnly? }. select: the placeholder text in code that's
// selected after inserting, so typing replaces it. scopeOnly: only offered in a scope's editor
// (the globals can't import scopes).

const EDITOR_SNIPPET_GROUPS = [
    {
        title: 'Items',
        snippets: [
            {
                label: 'Look up an item',
                code: "const Item = getOsrsItem('Item name');",
                select: 'Item name',
            },
            {
                label: 'Item margin',
                code: [
                    "const Item = getOsrsItem('Item name');",
                    '// Buy at the low price, sell at the high price',
                    'const Margin = Item.highPrice - Item.lowPrice;',
                ].join('\n'),
                select: 'Item name',
            },
            {
                label: 'Items with a tag',
                code: "const Items = queryOsrsItems().tagged('tag').sortBy('highPrice', 'desc').list();",
                select: 'tag',
            },
            {
                label: 'Recipes for an item',
                code: "const Recipes = queryOsrsItemRecipes().producing('Item name').list();",
                select: 'Item name',
            },
            {
                label: 'Item links',
                code: "const Links = queryOsrsItemLinks('grows-into').fromTagged('tag').list();",
                select: 'tag',
            },
        ],
    },
    {
        title: 'Logic',
        snippets: [
            {
                label: 'Variable with description',
                code: [
                    '// Description',
                    '// @tags: TAG',
                    'const Name = 0;',
                ].join('\n'),
                select: 'Description',
            },
            {
                label: 'If / else',
                code: [
                    'if (condition) {',
                    '    ',
                    '} else {',
                    '    ',
                    '}',
                ].join('\n'),
                select: 'condition',
            },
            {
                label: 'Loop with a total',
                code: [
                    'let Total = 0;',
                    'for (const item of Items) {',
                    '    Total += item.highPrice;',
                    '}',
                ].join('\n'),
                select: 'Items',
            },
            {
                label: 'Function',
                code: [
                    'function name(value) {',
                    '    return value;',
                    '}',
                ].join('\n'),
                select: 'name',
            },
        ],
    },
    {
        title: 'UI',
        snippets: [
            {
                label: 'Item strip',
                code: "ui.items(Items, { title: 'Items', shape: 'square' });",
                select: 'Items',
            },
            {
                label: 'Item table',
                code: [
                    'ui.table(Items, {',
                    "    title: 'Items',",
                    "    sortBy: 'Margin',",
                    "    sortDir: 'desc',",
                    "    search: ['Item'],",
                    '    columns: [',
                    "        { label: 'Item', type: 'item', value: item => item },",
                    "        { label: 'Buy', type: 'price', key: 'lowPrice' },",
                    "        { label: 'Sell', type: 'price', key: 'highPrice' },",
                    "        { label: 'Margin', type: 'signedPrice', value: item => item.highPrice - item.lowPrice, total: 'sum' },",
                    "        { label: 'ROI', type: 'percent', value: item => (item.highPrice - item.lowPrice) / item.lowPrice },",
                    "        { label: 'Limit', type: 'number', key: 'limit' },",
                    '    ],',
                    '});',
                ].join('\n'),
                select: 'Items',
            },
            {
                label: 'Table of rows',
                code: [
                    'ui.table([',
                    "    { name: 'A', amount: 1 },",
                    "    { name: 'B', amount: 2 },",
                    '], {',
                    "    title: 'Title',",
                    '    columns: [',
                    "        { label: 'Name', type: 'text', key: 'name' },",
                    "        { label: 'Amount', type: 'number', key: 'amount', total: 'sum' },",
                    '    ],',
                    '});',
                ].join('\n'),
                select: 'Title',
            },
            {
                label: 'Stats',
                code: "ui.stats({ Profit, Margin }, { types: { Profit: 'signedPrice', Margin: 'percent' } });",
                select: 'Profit, Margin',
            },
            {
                label: 'Heading',
                code: "ui.heading('Heading');",
                select: 'Heading',
            },
            {
                label: 'Text',
                code: "ui.text('Text');",
                select: 'Text',
            },
        ],
    },
    {
        title: 'Scope',
        snippets: [
            {
                label: 'Import from a scope',
                code: "const { Profit } = importScope('Scope name');",
                select: 'Scope name',
                scopeOnly: true,
            },
            {
                label: 'Public values (return)',
                code: 'return { Name };',
                select: 'Name',
            },
        ],
    },
];

// The snippet groups for an editor, without the scope-only snippets when imports aren't
// allowed. Groups left empty are dropped.
const editorSnippetGroups = (allowImports) => {
    const groups = [];
    for (const group of EDITOR_SNIPPET_GROUPS) {
        const snippets = group.snippets.filter(snippet => allowImports || !snippet.scopeOnly);
        if (snippets.length) {
            groups.push({ title: group.title, snippets });
        }
    }
    return groups;
};


// --- Components -------------------------------------------------------------------------------

const MENU_CARET_SVG = `<svg class="editor-menu-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;

// allowImports: also offer importScope snippets (a scope's editor, not the globals').
const EditorInsertMenu = {
    props: { allowImports: Boolean },
    emits: ['insert'],
    setup(props, { emit }) {
        const { isOpen, containerRef, close, toggle } = useDropdownMenu();
        const groups = computed(() => editorSnippetGroups(props.allowImports));

        const insert = (snippet) => {
            close();
            emit('insert', snippet);
        };

        // Only the first line is previewed; the button's title shows the whole snippet.
        const firstLine = (code) => code.split('\n')[0];

        return { isOpen, containerRef, toggle, groups, insert, firstLine };
    },
    template: `
        <div class="editor-menu" ref="containerRef">
            <button type="button" class="editor-menu-btn" :class="{ open: isOpen }"
                    aria-haspopup="menu" :aria-expanded="isOpen"
                    title="Insert a snippet of code on the line after the caret"
                    @click="toggle">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
                Insert
                ${MENU_CARET_SVG}
            </button>
            <div v-if="isOpen" class="editor-menu-panel editor-insert-panel" role="menu">
                <template v-for="group in groups" :key="group.title">
                    <div class="editor-menu-heading">{{ group.title }}</div>
                    <button v-for="snippet in group.snippets" :key="snippet.label"
                            type="button" class="editor-menu-item" role="menuitem"
                            :title="snippet.code"
                            @click="insert(snippet)">
                        <span class="editor-menu-item-label">{{ snippet.label }}</span>
                        <code class="editor-menu-item-code">{{ firstLine(snippet.code) }}</code>
                    </button>
                </template>
            </div>
        </div>
    `
};

// Checkboxes for the shared editorSettings; any combination can be on at once.
const EditorViewMenu = {
    setup() {
        const { isOpen, containerRef, toggle } = useDropdownMenu();
        return { isOpen, containerRef, toggle, editorSettings };
    },
    template: `
        <div class="editor-menu" ref="containerRef">
            <button type="button" class="editor-menu-btn" :class="{ open: isOpen }"
                    aria-haspopup="menu" :aria-expanded="isOpen"
                    title="Highlighting and line numbers"
                    @click="toggle">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
                View
                ${MENU_CARET_SVG}
            </button>
            <div v-if="isOpen" class="editor-menu-panel" role="menu">
                <div class="editor-menu-heading">Highlight</div>
                <label class="editor-menu-check" title="Tint variables and item lookups with their color">
                    <input type="checkbox" v-model="editorSettings.variableHighlight">
                    <span class="editor-toggle-swatch swatch-vars"></span>Variables
                </label>
                <label class="editor-menu-check" title="Color keywords, strings, numbers and comments">
                    <input type="checkbox" v-model="editorSettings.syntaxHighlight">
                    <span class="editor-toggle-swatch swatch-syntax"></span>Syntax
                </label>
                <div class="editor-menu-heading">Show</div>
                <label class="editor-menu-check" title="Show line numbers beside the code">
                    <input type="checkbox" v-model="editorSettings.lineNumbers">
                    <span class="editor-toggle-swatch swatch-lines"></span>Line numbers
                </label>
            </div>
        </div>
    `
};
