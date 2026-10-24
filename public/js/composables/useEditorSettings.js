// View options shared by every code editor, saved with the user's settings (see useTrackerStore).
// A single module-level object, so every FormulaInput and toggle sees the same settings without
// passing props around.
const editorSettings = reactive({
    variableHighlight: true, // tint variables and item lookups with their color
    syntaxHighlight: true,   // color keywords, strings, numbers, comments, ... like an IDE
    lineNumbers: true,       // show a line-number gutter beside the code
    uiInSidebar: false,      // show a UI section in the sidebar rather than full width above the editor
});

// Takes the saved settings over the defaults. Only known options with boolean values are used,
// so settings saved by another version of the app can't add or break options.
const applyEditorSettings = (stored) => {
    for (const key of Object.keys(editorSettings)) {
        if (typeof stored?.[key] === 'boolean') {
            editorSettings[key] = stored[key];
        }
    }
};
