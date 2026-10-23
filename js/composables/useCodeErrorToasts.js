// A sticky error toast for the code editor on the current tab, so an error is noticed even when
// the list under the editor is out of view. It shows the first error, updates as the errors
// change and goes away once the code is fixed. "Go to line" selects the line the error names.
// It waits for a pause in the errors changing, so it doesn't flicker on and off while typing.
// Closing it keeps it away until the code has no errors, or another editor's code is shown.
//
// Uses codeErrorLine from components/FormulaInput.js.

const CODE_ERROR_TOAST_KEY = 'code-error';
const CODE_ERROR_TOAST_DELAY = 800;

/**
 * A code editor whose errors get the toast.
 * @typedef {Object} ErrorToastEditor
 * @property {function(): string} label The code's name for the toast, e.g. "globals.js".
 * @property {Ref<string[]>} errors The code's error messages.
 * @property {Ref<Object|null>} editorRef The FormulaInput showing the code.
 */

/**
 * The toast's text: the first error, and how many more there are.
 * @param {string} label
 * @param {string[]} errors At least one.
 * @returns {string}
 */
const codeErrorToastMessage = (label, errors) => {
    const message = `${label}: ${errors[0]}`;
    if (errors.length === 1) {
        return message;
    }
    return `${message} (+${errors.length - 1} more)`;
};

/**
 * A "Go to line N" button for the line the first error names, or null if it names none.
 * @param {ErrorToastEditor} editor
 * @param {string} firstError
 * @returns {{ label: string, run: function(): void }|null}
 */
const goToErrorLineAction = (editor, firstError) => {
    const line = codeErrorLine(firstError);
    if (line === null) {
        return null;
    }

    return {
        label: `Go to line ${line}`,
        run: () => editor.editorRef.value?.revealLine(line),
    };
};

/**
 * @param {Object} options
 * @param {Ref<string>} options.activeTab
 * @param {Object<string, ErrorToastEditor>} options.editors By the tab they're on.
 * @param {function} options.showStickyToast From useToasts.
 * @param {function} options.dismissStickyToast From useToasts.
 */
const useCodeErrorToasts = ({ activeTab, editors, showStickyToast, dismissStickyToast }) => {
    let showTimer = null;
    let closedByUser = false;

    // What the toast would show now: { source, errors }, or null when the tab has no editor.
    // source tells editors (and scopes, which share one editor) apart.
    const current = computed(() => {
        const editor = editors[activeTab.value];
        if (!editor) {
            return null;
        }
        return { editor, source: `${activeTab.value}:${editor.label()}`, errors: editor.errors.value };
    });

    const show = ({ editor, errors }) => {
        showStickyToast(CODE_ERROR_TOAST_KEY, codeErrorToastMessage(editor.label(), errors), {
            action: goToErrorLineAction(editor, errors[0]),
            onClose: () => {
                closedByUser = true;
            },
        });
    };

    watch(current, (now, before) => {
        clearTimeout(showTimer);

        // A toast about other code (another tab or scope) is stale at once, as is one about fixed code.
        const isNewSource = !before || !now || before.source !== now.source;
        const hasErrors = Boolean(now && now.errors.length);
        if (isNewSource || !hasErrors) {
            dismissStickyToast(CODE_ERROR_TOAST_KEY);
            closedByUser = false;
        }

        if (!hasErrors || closedByUser) {
            return;
        }
        showTimer = setTimeout(() => show(now), CODE_ERROR_TOAST_DELAY);
    }, { immediate: true });
};
