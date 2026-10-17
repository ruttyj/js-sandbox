// Toggles for how code editors are highlighted (see editorSettings). Both can be on at once.
const EditorViewToggles = {
    setup() {
        return { editorSettings };
    },
    template: `
        <div class="editor-toggles" role="group" aria-label="Editor highlighting">
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
        </div>
    `
};
