// Toggles for how code editors are shown (see editorSettings): highlighting and line numbers.
// Any combination can be on at once.
const EditorViewToggles = {
    setup() {
        return { editorSettings };
    },
    template: `
        <div class="editor-toggles" role="group" aria-label="Editor view">
            <span class="editor-toggles-label">Highlight</span>
            <button type="button" class="editor-toggle" :class="{ on: editorSettings.variableHighlight }"
                    :aria-pressed="editorSettings.variableHighlight"
                    title="Tint variables and item lookups with their color"
                    @click="editorSettings.variableHighlight = !editorSettings.variableHighlight">
                <span class="editor-toggle-swatch swatch-vars"></span>Variables
            </button>
            <button type="button" class="editor-toggle" :class="{ on: editorSettings.syntaxHighlight }"
                    :aria-pressed="editorSettings.syntaxHighlight"
                    title="Color keywords, strings, numbers and comments"
                    @click="editorSettings.syntaxHighlight = !editorSettings.syntaxHighlight">
                <span class="editor-toggle-swatch swatch-syntax"></span>Syntax
            </button>
            <span class="editor-toggles-label editor-toggles-label-gap">Show</span>
            <button type="button" class="editor-toggle" :class="{ on: editorSettings.lineNumbers }"
                    :aria-pressed="editorSettings.lineNumbers"
                    title="Show line numbers beside the code"
                    @click="editorSettings.lineNumbers = !editorSettings.lineNumbers">
                <span class="editor-toggle-swatch swatch-lines"></span>Lines
            </button>
        </div>
    `
};
