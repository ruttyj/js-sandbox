// Textarea with a syntax-highlighted backdrop: variable keys and item refs (getOsrsItem('Name')
// and legacy I_<id>_H/L) are tinted with their color, and optionally the code is colored like an
// IDE (see editorSettings). The backdrop must mirror the textarea's size and scroll exactly.
//
// The pure parts (editing keys, highlighting) are plain functions above the component; the
// component wires them to the DOM.


// --- Editing keys -----------------------------------------------------------------------------
// Tab inserts two spaces; with a selection it indents every selected line. Shift+Tab outdents
// the current line, or every selected line, by up to two spaces (or one tab). Each returns the
// edited { value, start, end } (start / end: the new selection), or null when nothing changes.

const INDENT = '  ';

// The whole lines a selection touches, as [lineStart, lineEnd). A selection ending just after a
// newline (e.g. made by dragging down to the start of a line) doesn't touch the line below it.
const selectedLineSpan = (value, start, end) => {
    const lastSelected = end > start && value[end - 1] === '\n' ? end - 1 : end;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const nextNewline = value.indexOf('\n', lastSelected);
    return { lineStart, lineEnd: nextNewline === -1 ? value.length : nextNewline };
};

const insertIndent = (value, start, end) => ({
    value: value.substring(0, start) + INDENT + value.substring(end),
    start: start + INDENT.length,
    end: start + INDENT.length,
});

const indentLines = (value, start, end) => {
    const { lineStart, lineEnd } = selectedLineSpan(value, start, end);
    const lines = value.substring(lineStart, lineEnd).split('\n');
    const indented = lines.map(line => INDENT + line).join('\n');
    return {
        value: value.substring(0, lineStart) + indented + value.substring(lineEnd),
        start: start + INDENT.length,
        end: end + lines.length * INDENT.length,
    };
};

// How much indentation Shift+Tab removes from a line.
const outdentWidth = (line) => (line.startsWith('\t') ? 1 : (line.match(/^ {1,2}/) || [''])[0].length);

// Where a position in the original text ends up once the indentation is removed.
// removals: [lineStart, removed] per line. A position inside removed indentation lands at the
// start of its line.
const positionAfterRemovals = (pos, removals) => removals.reduce(
    (p, [lineStart, removed]) => (lineStart < pos ? p - Math.min(removed, pos - lineStart) : p), pos);

const outdentLines = (value, start, end) => {
    const { lineStart, lineEnd } = selectedLineSpan(value, start, end);
    const removals = [];
    let nextLineStart = lineStart;
    const lines = value.substring(lineStart, lineEnd).split('\n').map(line => {
        const removed = outdentWidth(line);
        removals.push([nextLineStart, removed]);
        nextLineStart += line.length + 1;
        return line.substring(removed);
    });
    if (removals.every(([, removed]) => removed === 0)) return null;

    return {
        value: value.substring(0, lineStart) + lines.join('\n') + value.substring(lineEnd),
        start: positionAfterRemovals(start, removals),
        end: positionAfterRemovals(end, removals),
    };
};

const tabEdit = (value, start, end, outdent) => {
    if (outdent) return outdentLines(value, start, end);
    return start === end ? insertIndent(value, start, end) : indentLines(value, start, end);
};

// Ctrl+X with nothing selected cuts the caret's whole line, newline included (as in VS Code).
// The last line has no newline after it, so the one before it is taken instead.
// Returns the [start, end) range to select.
const lineCutRange = (value, caret) => {
    const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
    const newline = value.indexOf('\n', caret);
    if (newline !== -1) return [lineStart, newline + 1];
    if (lineStart > 0) return [lineStart - 1, value.length];
    return [0, value.length];
};

const isCutShortcut = (e) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'x';


// --- Highlighting -----------------------------------------------------------------------------

const ITEM_LOOKUP_PATTERN = /(?<itemLookup>getOsrsItem\(\s*(?<quote>['"])(?<itemName>(?:\\.|(?!\k<quote>).)*?)\k<quote>\s*\)(?:\.(?<itemField>highPrice|lowPrice))?)/.source;
const LEGACY_ITEM_REF_PATTERN = /(?<itemRef>I_(?<itemId>\d+)_(?<itemType>H|L))/.source;

// Syntax highlighting tokens. Unterminated comments and strings run to the end so typing one
// doesn't flicker. Numbers include RS shorthand like 10k / 1.5m / 2b.
const SYNTAX_COMMENT_PATTERN = /(?<comment>\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))/.source;
const SYNTAX_STRING_PATTERN = /(?<string>'(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?|`(?:\\[\s\S]|[^`\\])*`?)/.source;
const SYNTAX_NUMBER_PATTERN = /(?<number>\b(?:0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?[kmb]?)\b|\.\d+\b)/.source;
const SYNTAX_IDENT_PATTERN = /(?<ident>[A-Za-z_$][\w$]*)/.source;
const SYNTAX_OP_PATTERN = /(?<op>=>|[=!<>]=?=?|&&|\|\||\?\?|[-+*\/%&|^~?:]=?|\.\.\.)/.source;
const SYNTAX_PUNCT_PATTERN = /(?<punct>[{}()\[\];,.])/.source;
const SYNTAX_KEYWORDS = new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'of', 'in',
    'break', 'continue', 'switch', 'case', 'default', 'new', 'typeof', 'instanceof', 'try',
    'catch', 'finally', 'throw', 'class', 'this', 'delete', 'void', 'async', 'await', 'yield',
]);
const SYNTAX_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

// Tokens whose CSS class is just their group name (tok-comment, tok-string, ...).
const PLAIN_TOKEN_GROUPS = ['comment', 'string', 'number', 'op', 'punct'];

// An item ref's outline tells high from low price at a glance.
const HIGH_PRICE_BORDER = '#FFF5';
const LOW_PRICE_BORDER = '#000';
const TINT_BASE_STYLE = 'border-radius: 4px;';

// One regex matching every token to color. Order matters: comments and item lookups must win
// over the strings and operators inside them, and variables over plain identifiers. Named
// groups tell the tokens apart. variableKeys: longest first, so `Profit` beats `Pro`.
const buildHighlightRegex = (variableKeys, syntax) => {
    const parts = [];
    if (syntax) parts.push(SYNTAX_COMMENT_PATTERN);
    parts.push(ITEM_LOOKUP_PATTERN, LEGACY_ITEM_REF_PATTERN);
    if (syntax) parts.push(SYNTAX_STRING_PATTERN);
    if (variableKeys.length) parts.push(`\\b(?<varKey>${variableKeys.map(escapeRegex).join('|')})\\b`);
    if (syntax) parts.push(SYNTAX_NUMBER_PATTERN, SYNTAX_IDENT_PATTERN, SYNTAX_OP_PATTERN, SYNTAX_PUNCT_PATTERN);
    return new RegExp(parts.join('|'), 'gi');
};

const syntaxToken = (cls, text) => `<span class="tok-${cls}">${escapeHtml(text)}</span>`;

// hl (the highlight context): { text, tint, syntax, variables, itemsById, itemsByName }.

// The tint around an item ref wraps its own (possibly syntax-colored) parts.
const tintItemRef = (hl, color, borderColor, innerHtml) => (hl.tint
    ? `<span style="background-color: ${color}60; ${TINT_BASE_STYLE} box-shadow: 0 0 0 2px ${borderColor};">${innerHtml}</span>`
    : innerHtml);

// Variable spans always keep data-var-key, even untinted, so the color picker can find them.
const renderVariable = (hl, varKey) => {
    const variable = hl.variables.find(v => v.key.toUpperCase() === varKey.toUpperCase());
    const color = variable?.color || UNDECLARED_COLOR;
    const keyAttr = variable ? ` data-var-key="${variable.key}"` : '';
    const cls = hl.syntax ? ' class="tok-var"' : '';
    const style = hl.tint ? ` style="background-color: ${color}60; ${TINT_BASE_STYLE} box-shadow: 0 0 2px ${color};"` : '';
    return `<span${keyAttr}${cls}${style}>${escapeHtml(varKey)}</span>`;
};

// getOsrsItem ( 'Name' ) .field, each part colored; the name may itself contain parentheses.
const syntaxColoredItemLookup = (lookup) => {
    const parts = lookup.match(/^(getOsrsItem)(\(\s*)([\s\S]*?)(\s*\))(?:(\.)(\w+))?$/i);
    if (!parts) return escapeHtml(lookup);
    const [, fn, open, name, close, dot, field] = parts;
    return syntaxToken('fn', fn) + syntaxToken('punct', open) + syntaxToken('string', name) + syntaxToken('punct', close)
        + (dot ? syntaxToken('punct', dot) + syntaxToken('prop', field) : '');
};

const renderItemLookup = (hl, { itemLookup, itemName, itemField }) => {
    const item = hl.itemsByName.get(itemNameKey(unescapeQuoted(itemName)));
    const color = item?.color || UNDECLARED_COLOR;
    const field = (itemField || '').toLowerCase();
    const borderColor = field === 'highprice' ? HIGH_PRICE_BORDER : field === 'lowprice' ? LOW_PRICE_BORDER : color;
    const inner = hl.syntax ? syntaxColoredItemLookup(itemLookup) : escapeHtml(itemLookup);
    return tintItemRef(hl, color, borderColor, inner);
};

const renderLegacyItemRef = (hl, { itemRef, itemId, itemType }) => {
    const item = hl.itemsById.get(itemId);
    const color = item?.color || UNDECLARED_COLOR;
    const borderColor = itemType.toUpperCase() === 'H' ? HIGH_PRICE_BORDER : LOW_PRICE_BORDER;
    return tintItemRef(hl, color, borderColor, hl.syntax ? syntaxToken('var', itemRef) : escapeHtml(itemRef));
};

// An identifier followed by "(" is a call; one after "." is a property.
const identifierClass = (ident, text, start, end) => {
    if (SYNTAX_KEYWORDS.has(ident)) return 'keyword';
    if (SYNTAX_LITERALS.has(ident)) return 'literal';
    if (/^\s*\(/.test(text.slice(end))) return 'fn';
    if (text[start - 1] === '.') return 'prop';
    return 'ident';
};

const renderHighlightMatch = (hl, match) => {
    const groups = match.groups;
    if (groups.varKey) return renderVariable(hl, groups.varKey);
    if (groups.itemLookup) return renderItemLookup(hl, groups);
    if (groups.itemRef) return renderLegacyItemRef(hl, groups);
    if (groups.ident) {
        const end = match.index + match[0].length;
        return syntaxToken(identifierClass(groups.ident, hl.text, match.index, end), groups.ident);
    }
    const plain = PLAIN_TOKEN_GROUPS.find(name => groups[name]);
    return plain ? syntaxToken(plain, groups[plain]) : escapeHtml(match[0]);
};

// The backdrop's HTML, built in one pass over the raw text. tint colors variables and item
// refs; syntax also colors comments, strings, numbers, keywords, ... (the textarea text is then
// made transparent so the colored backdrop shows through). The trailing <br> keeps a final
// empty line as tall as the textarea's.
const highlightCode = (hl) => {
    const regex = buildHighlightRegex(hl.variables.map(v => v.key), hl.syntax);
    let html = '';
    let last = 0;
    for (const match of hl.text.matchAll(regex)) {
        html += escapeHtml(hl.text.slice(last, match.index)) + renderHighlightMatch(hl, match);
        last = match.index + match[0].length;
    }
    return html + escapeHtml(hl.text.slice(last)) + '<br>';
};


// --- Component --------------------------------------------------------------------------------

// colorEditable: hovering a variable shows a small color picker, which emits set-color(key, color).
const FormulaInput = {
    // Flags are typed as Boolean so a bare attribute (`readonly`, `color-editable`) is true (untyped, it would be "").
    props: {
        modelValue: null, variables: null, placeholder: null, items: null,
        readonly: Boolean,
        colorEditable: Boolean,
    },
    emits: ['update:modelValue', 'focus', 'blur', 'input', 'set-color'],
    setup(props, { emit, expose }) {
        const textareaRef = ref(null);
        const backdropRef = ref(null);
        const containerRef = ref(null);
        let resizeObserver = null;

        // Color tooltip. The textarea sits over the backdrop, so the hovered variable is found by
        // hit-testing the backdrop's variable spans. { key, color, top, left } or null.
        // It fades out on its own unless the pointer is on it, and stays away for that variable
        // until the pointer leaves it, so it doesn't keep covering the code being read.
        const TIP_SHOW_DELAY = 350;
        const TIP_LEAVE_DELAY = 250;
        const TIP_IDLE_TIMEOUT = 1000;
        const colorTip = ref(null);
        let showTimer = null;
        let hideTimer = null;
        let idleTimer = null;
        let pickerOpen = false; // the native color dialog is open; keep the tooltip up
        let tipHovered = false;
        let dismissedKey = null;

        const clearTimers = () => {
            clearTimeout(showTimer);
            clearTimeout(hideTimer);
            clearTimeout(idleTimer);
        };

        // dismiss: don't show it again for this variable until the pointer leaves it.
        const hideColorTip = (dismiss = false) => {
            clearTimers();
            if (dismiss && colorTip.value) dismissedKey = colorTip.value.key;
            pickerOpen = false;
            tipHovered = false;
            colorTip.value = null;
        };

        const dismissColorTip = () => hideColorTip(true);

        const hideColorTipSoon = () => {
            clearTimeout(showTimer);
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                if (!pickerOpen && !tipHovered) hideColorTip();
            }, TIP_LEAVE_DELAY);
        };

        const startIdleTimer = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                if (!pickerOpen && !tipHovered) hideColorTip(true);
            }, TIP_IDLE_TIMEOUT);
        };

        const handleTipEnter = () => {
            tipHovered = true;
            clearTimeout(hideTimer);
            clearTimeout(idleTimer);
        };

        const handleTipLeave = () => {
            tipHovered = false;
            hideColorTipSoon();
            startIdleTimer();
        };

        const variableSpanAt = (x, y) => {
            const spans = backdropRef.value ? backdropRef.value.querySelectorAll('[data-var-key]') : [];
            for (const span of spans) {
                for (const rect of span.getClientRects()) {
                    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return { span, rect };
                }
            }
            return null;
        };

        const showColorTip = (key, rect) => {
            const variable = (props.variables || []).find(v => v.key === key);
            colorTip.value = { key, color: variable?.color || UNDECLARED_COLOR, top: rect.bottom + 4, left: rect.left };
            startIdleTimer();
        };

        const handleMouseMove = (e) => {
            if (!props.colorEditable) return;
            const hit = variableSpanAt(e.clientX, e.clientY);
            const key = hit ? hit.span.dataset.varKey : null;
            if (key !== dismissedKey) dismissedKey = null;
            if (!key) {
                if (colorTip.value) hideColorTipSoon();
                else clearTimeout(showTimer);
                return;
            }
            if (key === dismissedKey) return;
            clearTimeout(hideTimer);
            if (colorTip.value?.key === key) return;
            clearTimeout(showTimer);
            // A short delay so passing over a variable while moving the mouse doesn't flash a
            // tooltip; once one is showing, moving to another variable switches at once.
            showTimer = setTimeout(() => showColorTip(key, hit.rect), colorTip.value ? 0 : TIP_SHOW_DELAY);
        };

        const handleColorInput = (e) => {
            if (!colorTip.value) return;
            colorTip.value.color = e.target.value;
            emit('set-color', colorTip.value.key, e.target.value);
        };

        const handlePickerClosed = () => {
            pickerOpen = false;
            startIdleTimer();
        };

        const autoResize = () => {
            if (!textareaRef.value || !containerRef.value) return;
            textareaRef.value.style.height = 'auto';
            const newHeight = Math.max(38, textareaRef.value.scrollHeight);
            // Only grow; never shrink below a height the user set with the resize handle.
            if (!containerRef.value.style.height || parseInt(containerRef.value.style.height) < newHeight) {
                containerRef.value.style.height = newHeight + 'px';
            }
            textareaRef.value.style.height = '100%';
        };

        const find = useFindReplace({
            getText: () => props.modelValue || '',
            textareaRef,
            isReadonly: () => props.readonly,
            syncLayers: () => {
                syncStyles();
                syncScroll();
            },
        });

        // The layers that mirror the textarea: the highlight backdrop and, while find is open, its matches.
        const mirrorLayers = () => [backdropRef.value, find.findLayerRef.value].filter(Boolean);

        // Matches the layers' right padding to the textarea's scrollbar, so lines wrap at the same width.
        const syncStyles = () => {
            if (!textareaRef.value) return;
            const scrollbarWidth = textareaRef.value.offsetWidth - textareaRef.value.clientWidth;
            mirrorLayers().forEach(layer => { layer.style.paddingRight = `${10 + scrollbarWidth}px`; });
        };

        const syncScroll = () => {
            if (!textareaRef.value) return;
            mirrorLayers().forEach(layer => {
                layer.scrollTop = textareaRef.value.scrollTop;
                layer.scrollLeft = textareaRef.value.scrollLeft;
            });
        };

        const syncAll = () => {
            autoResize();
            syncStyles();
            syncScroll();
        };

        const emitEdit = (value, e) => {
            emit('update:modelValue', value);
            emit('input', e);
        };

        const handleInput = (e) => {
            hideColorTip();
            emitEdit(e.target.value, e);
            syncAll();
        };

        // Only selects the line and lets the browser's own cut run, so the clipboard and Ctrl+Z
        // work as usual.
        const selectLineForCut = (el) => {
            if (props.readonly || el.selectionStart !== el.selectionEnd) return;
            el.setSelectionRange(...lineCutRange(el.value, el.selectionStart));
        };

        const handleTab = (e) => {
            e.preventDefault();
            const el = e.target;
            const edit = tabEdit(el.value, el.selectionStart, el.selectionEnd, e.shiftKey);
            if (!edit) return;
            el.value = edit.value;
            el.selectionStart = edit.start;
            el.selectionEnd = edit.end;
            emitEdit(edit.value, e);
            nextTick(syncAll);
        };

        const handleKeydown = (e) => {
            if (colorTip.value) dismissColorTip();
            if (find.handleEditorFindKeys(e)) return;
            if (isCutShortcut(e)) selectLineForCut(e.target);
            else if (e.key === 'Tab' && !props.readonly) handleTab(e);
        };

        watch(() => props.modelValue, () => nextTick(syncAll));

        onMounted(() => {
            if (!textareaRef.value || !backdropRef.value) return;
            resizeObserver = new ResizeObserver(() => {
                syncStyles();
                syncScroll();
            });
            resizeObserver.observe(textareaRef.value);
            autoResize();
            syncStyles();
        });

        onBeforeUnmount(() => {
            if (resizeObserver) resizeObserver.disconnect();
            clearTimers();
        });

        const itemLookup = computed(() => {
            const byId = new Map();
            const byName = new Map();
            (props.items || []).forEach(item => {
                byId.set(String(item.id), item);
                if (item.name) byName.set(itemNameKey(item.name), item);
            });
            return { byId, byName };
        });

        const highlightedHTML = computed(() => highlightCode({
            text: props.modelValue || '',
            tint: editorSettings.variableHighlight,
            syntax: editorSettings.syntaxHighlight,
            variables: (props.variables || [])
                .filter(v => v.key && v.key.trim().length > 0)
                .sort((a, b) => b.key.length - a.key.length),
            itemsById: itemLookup.value.byId,
            itemsByName: itemLookup.value.byName,
        }));

        const focus = () => textareaRef.value?.focus();

        expose({ focus, textareaRef });

        const handleScroll = () => {
            syncScroll();
            if (colorTip.value && !pickerOpen) hideColorTip();
        };

        return {
            ...find,
            editorSettings,
            textareaRef, backdropRef, containerRef, handleInput, handleKeydown, handleScroll, highlightedHTML,
            colorTip, handleMouseMove, hideColorTipSoon, dismissColorTip, handleTipEnter, handleTipLeave,
            handleColorInput, handlePickerClosed,
            openPicker: () => { pickerOpen = true; },
        };
    },
    template: `
        <div class="formula-input-container" :class="{ 'syntax-on': editorSettings.syntaxHighlight }" ref="containerRef">
            <div class="formula-backdrop" ref="backdropRef" v-html="highlightedHTML"></div>
            <div v-if="findOpen" class="formula-backdrop formula-find-layer" ref="findLayerRef" v-html="findLayerHTML"></div>
            <div class="formula-find-probe" ref="findProbeRef"></div>
            <textarea
                ref="textareaRef"
                class="formula-textarea"
                :value="modelValue"
                @input="handleInput"
                @keydown="handleKeydown"
                @scroll="handleScroll"
                @mousemove="handleMouseMove"
                @mouseleave="hideColorTipSoon"
                @mousedown="dismissColorTip"
                @focus="$emit('focus')"
                @blur="$emit('blur')"
                :placeholder="placeholder"
                :readonly="readonly"
                spellcheck="false"
            ></textarea>
            <div v-if="findOpen" class="find-panel" @keydown="handleFindKeydown">
                <button
                    class="find-btn find-expand"
                    :class="{ hidden: readonly }"
                    :title="findShowReplace ? 'Hide replace' : 'Show replace (Ctrl+H)'"
                    @click="toggleReplace"
                >{{ findShowReplace ? '▾' : '▸' }}</button>
                <div class="find-rows">
                    <div class="find-row">
                        <div class="find-field" :class="{ invalid: findError }" :title="findError || ''">
                            <input ref="findInputRef" v-model="findQuery" placeholder="Find" spellcheck="false">
                            <button class="find-opt" :class="{ on: findCaseSensitive }" title="Match case (Alt+C)" @click="findCaseSensitive = !findCaseSensitive">Aa</button>
                            <button class="find-opt" :class="{ on: findWholeWord }" title="Match whole word (Alt+W)" @click="findWholeWord = !findWholeWord"><u>ab</u></button>
                            <button class="find-opt" :class="{ on: findUseRegex }" title="Use regular expression (Alt+R)" @click="findUseRegex = !findUseRegex">.*</button>
                        </div>
                        <span class="find-count" :class="{ empty: findQuery && !findMatches.length }">{{ findCountLabel }}</span>
                        <button class="find-btn" title="Previous match (Shift+Enter)" :disabled="!findMatches.length" @click="findStep(-1)">↑</button>
                        <button class="find-btn" title="Next match (Enter)" :disabled="!findMatches.length" @click="findStep(1)">↓</button>
                        <button class="find-btn" title="Close (Escape)" @click="closeFind">✕</button>
                    </div>
                    <div v-if="findShowReplace" class="find-row">
                        <div class="find-field">
                            <input ref="replaceInputRef" v-model="findReplacement" placeholder="Replace" spellcheck="false">
                        </div>
                        <button class="find-btn find-text-btn" title="Replace (Enter)" :disabled="!findMatches.length" @click="replaceOne">Replace</button>
                        <button class="find-btn find-text-btn" title="Replace all (Ctrl+Alt+Enter)" :disabled="!findMatches.length" @click="replaceAll">All</button>
                    </div>
                </div>
            </div>
            <teleport to="body">
                <transition name="formula-color-tip">
                <div
                    v-if="colorTip"
                    class="formula-color-tip"
                    :style="{ top: colorTip.top + 'px', left: colorTip.left + 'px' }"
                    @mouseenter="handleTipEnter"
                    @mouseleave="handleTipLeave"
                >
                    <input
                        type="color"
                        class="color-picker-input"
                        :value="colorTip.color"
                        :title="'Color of ' + colorTip.key"
                        @click="openPicker"
                        @input="handleColorInput"
                        @change="handlePickerClosed"
                        @blur="handlePickerClosed"
                    >
                    <span class="formula-color-tip-key">{{ colorTip.key }}</span>
                </div>
                </transition>
            </teleport>
        </div>
    `
};
