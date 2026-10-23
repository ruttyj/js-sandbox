// Textarea with a syntax-highlighted backdrop: variable keys and item refs (getOsrsItem('Name')
// and legacy I_<id>_H/L) are tinted with their color, and optionally the code is colored like an
// IDE (see editorSettings). The backdrop must mirror the textarea's size and scroll exactly.
// Hovering a variable or an item ref shows a FormulaTooltip with its value or item details.
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

// getOsrsItem('Name') or getOsrsItem(5316), optionally followed by .highPrice / .lowPrice.
const ITEM_LOOKUP_PATTERN = /(?<itemLookup>getOsrsItem\(\s*(?:(?<quote>['"])(?<itemName>(?:\\.|(?!\k<quote>).)*?)\k<quote>|(?<lookupId>\d+))\s*\)(?:\.(?<itemField>highPrice|lowPrice))?)/.source;
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
// itemsById is a plain object and itemsByName a Map, the shapes findItem takes.

// An item ref is always wrapped in a span carrying its getOsrsItem argument (a name or an ID),
// so the hover tooltip can find it; tinting adds the colored background around its own
// (possibly syntax-colored) parts. The argument is URI-encoded so any name is a safe attribute.
// sourceStart: where a getOsrsItem(...) call starts in the code, so the tooltip can replace it;
// null for legacy refs.
const tintItemRef = (hl, itemArg, sourceStart, color, borderColor, innerHtml) => {
    let argAttr = ` data-item-arg="${encodeURIComponent(itemArg)}"`;
    if (sourceStart !== null) {
        argAttr += ` data-item-start="${sourceStart}"`;
    }
    if (!hl.tint) {
        return `<span${argAttr}>${innerHtml}</span>`;
    }
    const style = `background-color: ${color}60; ${TINT_BASE_STYLE} box-shadow: 0 0 0 2px ${borderColor};`;
    return `<span${argAttr} style="${style}">${innerHtml}</span>`;
};

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
// An ID argument is colored as a number.
const syntaxColoredItemLookup = (lookup) => {
    const parts = lookup.match(/^(getOsrsItem)(\(\s*)([\s\S]*?)(\s*\))(?:(\.)(\w+))?$/i);
    if (!parts) return escapeHtml(lookup);
    const [, fn, open, arg, close, dot, field] = parts;
    const argClass = /^\d+$/.test(arg) ? 'number' : 'string';
    return syntaxToken('fn', fn) + syntaxToken('punct', open) + syntaxToken(argClass, arg) + syntaxToken('punct', close)
        + (dot ? syntaxToken('punct', dot) + syntaxToken('prop', field) : '');
};

const renderItemLookup = (hl, { itemLookup, itemName, lookupId, itemField }, start) => {
    const itemArg = lookupId ?? unescapeQuoted(itemName);
    const item = findItem(itemArg, hl.itemsById, hl.itemsByName);
    const color = item?.color || UNDECLARED_COLOR;
    const field = (itemField || '').toLowerCase();
    const borderColor = field === 'highprice' ? HIGH_PRICE_BORDER : field === 'lowprice' ? LOW_PRICE_BORDER : color;
    const inner = hl.syntax ? syntaxColoredItemLookup(itemLookup) : escapeHtml(itemLookup);
    return tintItemRef(hl, itemArg, start, color, borderColor, inner);
};

const renderLegacyItemRef = (hl, { itemRef, itemId, itemType }) => {
    const item = hl.itemsById[itemId];
    const color = item?.color || UNDECLARED_COLOR;
    const borderColor = itemType.toUpperCase() === 'H' ? HIGH_PRICE_BORDER : LOW_PRICE_BORDER;
    return tintItemRef(hl, itemId, null, color, borderColor, hl.syntax ? syntaxToken('var', itemRef) : escapeHtml(itemRef));
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
    if (groups.itemLookup) return renderItemLookup(hl, groups, match.index);
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


// --- Line numbers -----------------------------------------------------------------------------
// The gutter is a layer beside the textarea, never inside it, so selecting and copying code
// can't pick up the numbers. Each row holds its line's text (transparent) at the textarea's
// width, so a wrapped line's row grows just as tall as the line and the next number stays level
// with the next line. The number itself is positioned out into the gutter.

// At least two digits wide, so the gutter doesn't jump when the code reaches line 10.
const MIN_GUTTER_DIGITS = 2;

const gutterDigits = (text) => {
    const lineCount = text.split('\n').length;
    return Math.max(MIN_GUTTER_DIGITS, String(lineCount).length);
};

// An empty row holds a <br> so it is still one line tall. errorLines: the line numbers (from 1)
// whose number is marked as having an error.
const lineNumberGutterHtml = (text, errorLines) => {
    let html = '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const lineHtml = lines[i] === '' ? '<br>' : escapeHtml(lines[i]);
        const rowClass = errorLines.has(i + 1) ? 'gutter-row has-error' : 'gutter-row';
        html += `<div class="${rowClass}"><span class="gutter-num">${i + 1}</span>${lineHtml}</div>`;
    }
    return html;
};


// --- Error lines ------------------------------------------------------------------------------
// Code errors read "Line 3: x is not defined" (see parseScopeCode and formatRunError in
// engine.js). The lines they name are marked in a layer behind the code, built row by row like
// the gutter so a wrapped line's mark covers all of it.

// "Line 3: ..." -> 3. Anchored at the start, so the line in "Scope "A" has an error: Line 3: ..."
// (which is in the other scope's code) isn't taken for one of this code's lines.
const CODE_ERROR_LINE = /^Line (\d+):/;

// The line a code error names, or null when it doesn't name one (e.g. "Unclosed bracket").
const codeErrorLine = (message) => {
    const match = CODE_ERROR_LINE.exec(message);
    if (!match) {
        return null;
    }
    return Number(match[1]);
};

const codeErrorLines = (errors) => {
    const lines = new Set();
    for (const message of errors) {
        const line = codeErrorLine(message);
        if (line !== null) {
            lines.add(line);
        }
    }
    return lines;
};

// An error row underlines its code (the text is transparent; the wavy underline isn't), leaving
// out the indentation and trailing spaces so the squiggle starts where the code does.
const errorRowHtml = (line) => {
    const code = line.trim();
    if (code === '') {
        return '<div class="error-row"><br></div>';
    }

    const leading = line.slice(0, line.indexOf(code));
    return `<div class="error-row">${escapeHtml(leading)}<span class="error-squiggle">${escapeHtml(code)}</span></div>`;
};

const errorLayerHtml = (text, errorLines) => {
    let html = '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (errorLines.has(i + 1)) {
            html += errorRowHtml(lines[i]);
        } else {
            const lineHtml = lines[i] === '' ? '<br>' : escapeHtml(lines[i]);
            html += `<div class="error-layer-row">${lineHtml}</div>`;
        }
    }
    return html;
};

// Where line lineNo (from 1) starts and ends in text, newline excluded; null past the last line.
const lineRange = (text, lineNo) => {
    const lines = text.split('\n');
    if (lineNo < 1 || lineNo > lines.length) {
        return null;
    }

    let start = 0;
    for (let i = 0; i < lineNo - 1; i++) {
        start += lines[i].length + 1;
    }
    return { start, end: start + lines[lineNo - 1].length };
};


// --- Item calls in the code -------------------------------------------------------------------
// Where a getOsrsItem(...) call sits in the code, so the tooltip can rewrite it to look the item
// up by ID. A call is { start, end, text }: text is code.slice(start, end).

// Just the call (no .highPrice / .lowPrice), matched exactly at lastIndex.
const ITEM_CALL_AT = /getOsrsItem\(\s*(?:(['"])(?:\\.|(?!\1).)*?\1|\d+)\s*\)/y;

// The getOsrsItem(...) call starting at code[start], or null.
const itemCallAt = (code, start) => {
    ITEM_CALL_AT.lastIndex = start;
    const match = ITEM_CALL_AT.exec(code);
    if (!match) {
        return null;
    }
    return { start, end: start + match[0].length, text: match[0] };
};

// The getOsrsItem(...) call a variable is declared with, e.g. the call in
// `const MagicSeed = getOsrsItem('Magic seed');`, or null when it isn't declared that way.
const declaredItemCall = (code, key) => {
    const declaration = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegex(key)}\\s*=\\s*`, 'g');
    for (const match of code.matchAll(declaration)) {
        const call = itemCallAt(code, match.index + match[0].length);
        if (call) {
            return call;
        }
    }
    return null;
};


// --- Hover tooltip content --------------------------------------------------------------------
// tc (the tooltip context): { text, editable, variables, valueForKey, catalog }. text: the code;
// editable: whether the tooltip may rewrite it. catalog: { byId, byName, tagsOf?, labelOf? } over
// every GE item (or null); tagsOf / labelOf / isUserTag describe items' tags when item tags are
// loaded. valueForKey: key -> the variable's current value (or null when not provided).

// The backdrop spans a tooltip can be about (see renderVariable and tintItemRef).
const TIP_TARGET_SELECTOR = '[data-var-key], [data-item-arg]';

// The tooltip target under a point: { span, rect }, or null.
const tipTargetAt = (backdrop, x, y) => {
    const spans = backdrop ? backdrop.querySelectorAll(TIP_TARGET_SELECTOR) : [];
    for (const span of spans) {
        for (const rect of span.getClientRects()) {
            const isInside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
            if (isInside) {
                return { span, rect };
            }
        }
    }
    return null;
};

// What a target span is: 'var:<key>' or 'item:<argument>'. Used to tell targets apart.
const tipTargetId = (span) => {
    if (span.dataset.varKey) {
        return `var:${span.dataset.varKey}`;
    }
    return `item:${span.dataset.itemArg}`;
};

const catalogItem = (catalog, itemArg) => {
    if (!catalog) {
        return null;
    }
    return findItem(itemArg, catalog.byId, catalog.byName);
};

const isCatalogLoaded = (catalog) => Boolean(catalog && catalog.byName.size);

// An item's tags as [{ key, label, user }], or [] when the catalog has no tag data.
const catalogItemTags = (catalog, item) => {
    if (!item || !catalog?.tagsOf) {
        return [];
    }
    return catalog.tagsOf(item.id).map(key => ({
        key,
        label: catalog.labelOf ? catalog.labelOf(key) : key,
        user: Boolean(catalog.isUserTag && catalog.isUserTag(key)),
    }));
};

// The item a variable holds: one assigned a getOsrsItem(...) call directly, or failing that one
// whose value is an item object (e.g. `const Seed = pairs.Magic.seed`). Returns the item's
// getOsrsItem argument, or null when the variable isn't an item.
const variableItemArg = (tc, variable, value) => {
    const fromFormula = formulaItemArg(variable?.formula);
    if (fromFormula !== null) {
        return fromFormula;
    }

    const looksLikeItem = value !== null
        && typeof value === 'object'
        && Number.isInteger(value.id)
        && 'highPrice' in value;
    if (looksLikeItem && tc.catalog?.byId[value.id]) {
        return String(value.id);
    }
    return null;
};

// call: the getOsrsItem(...) call the tip is about, or null. It's only offered for rewriting
// (replaceCall) when the code is editable and the call looks the item up by name.
const itemTipContent = (tc, itemArg, call) => {
    const item = catalogItem(tc.catalog, itemArg);
    const canReplace = tc.editable && call !== null && item !== null && !isItemIdArg(itemArg);
    return {
        itemArg,
        item,
        itemTags: catalogItemTags(tc.catalog, item),
        itemsLoaded: isCatalogLoaded(tc.catalog),
        replaceCall: canReplace ? call : null,
    };
};

const variableTipContent = (tc, key) => {
    const variable = tc.variables.find(v => v.key === key);
    const hasValue = Boolean(tc.valueForKey);
    const value = hasValue ? tc.valueForKey(key) : undefined;
    const itemArg = variableItemArg(tc, variable, value);
    const noItem = { itemArg: null, item: null, itemTags: [], replaceCall: null };

    return {
        variable: {
            key,
            name: variable?.name || '',
            tags: variable?.tags || [],
            color: variable?.color || UNDECLARED_COLOR,
            value,
            hasValue,
        },
        ...(itemArg === null ? noItem : itemTipContent(tc, itemArg, declaredItemCall(tc.text, key))),
    };
};

// The tip FormulaTooltip renders for a target span; see the tip shape described there.
const buildTip = (tc, span, rect) => {
    const anchor = { top: rect.top, bottom: rect.bottom, left: rect.left };
    const target = tipTargetId(span);
    if (span.dataset.varKey) {
        return { target, anchor, ...variableTipContent(tc, span.dataset.varKey) };
    }
    const itemArg = decodeURIComponent(span.dataset.itemArg);
    const hasStart = span.dataset.itemStart !== undefined;
    const call = hasStart ? itemCallAt(tc.text, Number(span.dataset.itemStart)) : null;
    return { target, anchor, variable: null, ...itemTipContent(tc, itemArg, call) };
};


// --- Component --------------------------------------------------------------------------------

// colorEditable: the hover tooltip's swatch is a color picker, which emits set-color(key, color).
// items: the scope's colored items, for tinting item refs. itemCatalog: { byId, byName } over
// every GE item, for item tooltips. valueForKey: key -> the variable's current value, for tooltips.
// errors: the code's error messages; the lines they name are highlighted (see "Error lines").
const FormulaInput = {
    components: { 'formula-tooltip': FormulaTooltip },
    // Flags are typed as Boolean so a bare attribute (`readonly`, `color-editable`) is true (untyped, it would be "").
    props: {
        modelValue: null, variables: null, placeholder: null, items: null,
        itemCatalog: Object,
        valueForKey: Function,
        errors: Array,
        readonly: Boolean,
        colorEditable: Boolean,
    },
    emits: ['update:modelValue', 'focus', 'blur', 'input', 'set-color'],
    setup(props, { emit, expose }) {
        const textareaRef = ref(null);
        const backdropRef = ref(null);
        const gutterRef = ref(null);
        const errorLayerRef = ref(null);
        const containerRef = ref(null);
        let resizeObserver = null;

        // Hover tooltip. The textarea sits over the backdrop, so the hovered variable or item ref
        // is found by hit-testing the backdrop's spans. tip: see FormulaTooltip, or null.
        // It fades out on its own unless the pointer is on it, and stays away for that target
        // until the pointer leaves it, so it doesn't keep covering the code being read.
        const TIP_SHOW_DELAY = 350;
        const TIP_SWITCH_DELAY = 300;
        const TIP_LEAVE_DELAY = 250;
        const TIP_IDLE_TIMEOUT = 2500;
        const tip = ref(null);
        let showTimer = null;
        let hideTimer = null;
        let idleTimer = null;
        let pickerOpen = false; // the native color dialog is open; keep the tooltip up
        let tipHovered = false;
        let dismissedTarget = null;

        const clearTimers = () => {
            clearTimeout(showTimer);
            clearTimeout(hideTimer);
            clearTimeout(idleTimer);
        };

        // dismiss: don't show it again for this target until the pointer leaves it.
        const hideTip = (dismiss = false) => {
            clearTimers();
            if (dismiss && tip.value) {
                dismissedTarget = tip.value.target;
            }
            pickerOpen = false;
            tipHovered = false;
            tip.value = null;
        };

        const dismissTip = () => hideTip(true);

        const hideTipSoon = () => {
            clearTimeout(showTimer);
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                if (!pickerOpen && !tipHovered) {
                    hideTip();
                }
            }, TIP_LEAVE_DELAY);
        };

        const startIdleTimer = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                if (!pickerOpen && !tipHovered) {
                    hideTip(true);
                }
            }, TIP_IDLE_TIMEOUT);
        };

        const handleTipEnter = () => {
            tipHovered = true;
            clearTimeout(showTimer);
            clearTimeout(hideTimer);
            clearTimeout(idleTimer);
        };

        const handleTipLeave = () => {
            tipHovered = false;
            hideTipSoon();
            startIdleTimer();
        };

        const tooltipContext = () => ({
            text: props.modelValue || '',
            editable: !props.readonly,
            variables: props.variables || [],
            valueForKey: props.valueForKey || null,
            catalog: props.itemCatalog || null,
        });

        const showTip = (hit) => {
            tip.value = buildTip(tooltipContext(), hit.span, hit.rect);
            startIdleTimer();
        };

        const handleMouseMove = (e) => {
            const hit = tipTargetAt(backdropRef.value, e.clientX, e.clientY);
            const target = hit ? tipTargetId(hit.span) : null;
            if (target !== dismissedTarget) {
                dismissedTarget = null;
            }

            if (!target) {
                if (tip.value) {
                    hideTipSoon();
                } else {
                    clearTimeout(showTimer);
                }
                return;
            }
            if (target === dismissedTarget) {
                return;
            }

            clearTimeout(hideTimer);
            if (tip.value?.target === target) {
                return;
            }
            clearTimeout(showTimer);
            // A short delay so passing over a target while moving the mouse doesn't flash a
            // tooltip. Once one is showing, the pointer often crosses other targets on its way
            // into the card, so switching waits until it rests on the new target; reaching the
            // card cancels the switch (see handleTipEnter). Each move restarts the wait.
            const delay = tip.value ? TIP_SWITCH_DELAY : TIP_SHOW_DELAY;
            showTimer = setTimeout(() => showTip(hit), delay);
        };

        const handleColorInput = (color) => {
            const variable = tip.value?.variable;
            if (!variable) {
                return;
            }
            variable.color = color;
            emit('set-color', variable.key, color);
        };

        const handlePickerClosed = () => {
            pickerOpen = false;
            startIdleTimer();
        };

        // Rewrites the tooltip's getOsrsItem('Name') call as `replacement` (the lookup by ID).
        // The code is checked first, in case it changed since the tooltip opened.
        const handleReplaceCall = (replacement) => {
            const call = tip.value?.replaceCall;
            hideTip();
            if (!call) {
                return;
            }
            const code = props.modelValue || '';
            if (code.slice(call.start, call.end) !== call.text) {
                return;
            }
            find.insertText(call.start, call.end, replacement);
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

        // The layers that mirror the textarea: the highlight backdrop, the line-number gutter when
        // shown, the error lines when there are any and, while find is open, its matches.
        const mirrorLayers = () => {
            const layers = [backdropRef.value, gutterRef.value, errorLayerRef.value, find.findLayerRef.value];
            return layers.filter(Boolean);
        };

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
            hideTip();
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
            if (tip.value) dismissTip();
            if (find.handleEditorFindKeys(e)) return;
            if (isCutShortcut(e)) selectLineForCut(e.target);
            else if (e.key === 'Tab' && !props.readonly) handleTab(e);
        };

        watch(() => props.modelValue, () => nextTick(syncAll));
        // Showing the gutter narrows the code, which can rewrap it, and the new gutter starts unscrolled.
        watch(() => editorSettings.lineNumbers, () => nextTick(syncAll));

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
            const byId = {};
            const byName = new Map();
            (props.items || []).forEach(item => {
                byId[item.id] = item;
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

        const errorLines = computed(() => codeErrorLines(props.errors || []));

        const gutterHTML = computed(() => {
            if (!editorSettings.lineNumbers) {
                return '';
            }
            return lineNumberGutterHtml(props.modelValue || '', errorLines.value);
        });

        const errorLayerHTML = computed(() => {
            if (!errorLines.value.size) {
                return '';
            }
            return errorLayerHtml(props.modelValue || '', errorLines.value);
        });

        // The error layer appears and disappears with the errors, so it needs syncing when it does.
        watch(() => errorLines.value.size > 0, () => nextTick(syncAll));

        // The gutter's width, as a CSS variable the layers use to make room for it. In ch, so it
        // follows the code font's digit width.
        const containerStyle = computed(() => {
            if (!editorSettings.lineNumbers) {
                return null;
            }
            return { '--gutter-digits': gutterDigits(props.modelValue || '') };
        });

        const focus = () => textareaRef.value?.focus();

        // Scrolls the textarea so a row of a mirrored layer is in view, then the page (the editor
        // grows with its code, so the row can be below the window), the way find reveals a match.
        const scrollRowIntoView = (row) => {
            const ta = textareaRef.value;
            const top = row.offsetTop;
            const bottom = top + row.offsetHeight;
            if (top < ta.scrollTop || bottom > ta.scrollTop + ta.clientHeight) {
                ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
            }
            syncScroll();

            const probe = find.findProbeRef.value;
            if (probe) {
                probe.style.top = `${top - ta.scrollTop}px`;
                probe.style.height = `${row.offsetHeight}px`;
                probe.scrollIntoView({ block: 'nearest' });
            }
        };

        // Selects line lineNo (from 1) and scrolls to it, e.g. for an error toast's Go to line.
        const revealLine = (lineNo) => {
            const ta = textareaRef.value;
            const range = lineRange(props.modelValue || '', lineNo);
            if (!ta || !range) {
                return;
            }

            ta.focus({ preventScroll: true });
            ta.setSelectionRange(range.start, range.end);

            const row = errorLayerRef.value?.children[lineNo - 1];
            if (row) {
                scrollRowIntoView(row);
            }
        };

        expose({ focus, textareaRef, revealLine });

        const handleScroll = () => {
            syncScroll();
            if (tip.value && !pickerOpen) hideTip();
        };

        return {
            ...find,
            editorSettings,
            textareaRef, backdropRef, containerRef, handleInput, handleKeydown, handleScroll, highlightedHTML,
            gutterRef, gutterHTML, containerStyle, errorLayerRef, errorLayerHTML,
            tip, handleMouseMove, hideTipSoon, dismissTip, handleTipEnter, handleTipLeave,
            handleColorInput, handlePickerClosed, handleReplaceCall,
            openPicker: () => { pickerOpen = true; },
        };
    },
    template: `
        <div class="formula-input-container"
             :class="{ 'syntax-on': editorSettings.syntaxHighlight, 'lines-on': editorSettings.lineNumbers }"
             :style="containerStyle"
             ref="containerRef">
            <div v-if="editorSettings.lineNumbers" class="formula-backdrop formula-gutter" ref="gutterRef" aria-hidden="true" v-html="gutterHTML"></div>
            <div v-if="errorLayerHTML" class="formula-backdrop formula-error-layer" ref="errorLayerRef" aria-hidden="true" v-html="errorLayerHTML"></div>
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
                @mouseleave="hideTipSoon"
                @mousedown="dismissTip"
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
                <transition name="formula-tip">
                    <formula-tooltip
                        v-if="tip"
                        :tip="tip"
                        :color-editable="colorEditable"
                        @enter="handleTipEnter"
                        @leave="handleTipLeave"
                        @color-input="handleColorInput"
                        @picker-open="openPicker"
                        @picker-closed="handlePickerClosed"
                        @replace-call="handleReplaceCall"
                    ></formula-tooltip>
                </transition>
            </teleport>
        </div>
    `
};
