// View options shared by every code editor, remembered in localStorage. A single module-level
// object, so every FormulaInput and toggle sees the same settings without passing props around.
const EDITOR_SETTINGS_KEY = 'osrs-ge-tracker-editor-settings';

const editorSettings = reactive({
    variableHighlight: true, // tint variables and item lookups with their color
    syntaxHighlight: false,  // color keywords, strings, numbers, comments, ... like an IDE
    lineNumbers: false,      // show a line-number gutter beside the code
    uiInSidebar: false,      // show a UI section in the sidebar rather than full width above the editor
});

try {
    const stored = readStoredJson(EDITOR_SETTINGS_KEY, 'editor settings') || {};
    Object.keys(editorSettings).forEach(key => {
        if (typeof stored[key] === 'boolean') editorSettings[key] = stored[key];
    });
} catch (e) { console.error(e); }

watch(editorSettings, () => {
    try {
        writeStoredJson(EDITOR_SETTINGS_KEY, editorSettings);
    } catch (e) { console.error(e); }
});
