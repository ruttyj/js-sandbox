// Find / replace for FormulaInput, IDE style: Ctrl+F / Ctrl+H open it; match case, whole word
// and regex toggles (Alt+C / Alt+W / Alt+R); "3 of 12"; Enter / Shift+Enter or F3 / Shift+F3
// step through matches; Enter in the replace box replaces the current match, Ctrl+Alt+Enter
// replaces all. Every match is marked in a layer that mirrors the textarea, like the highlight
// backdrop does. Replacing goes through execCommand('insertText') so Ctrl+Z undoes it like typing.
const FIND_MATCH_LIMIT = 5000;
const FIND_STATUS_MS = 2500;

const escapeHtml = (text) => text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// Expands $&, $1..$99, $<name> and $$ in a regex replacement, as String.prototype.replace does.
// match: a RegExp exec result (or the same shape).
const expandReplacement = (replacement, match) => replacement.replace(/\$(\$|&|\d{1,2}|<([^>]*)>)/g, (token, ref, name) => {
    if (ref === '$') return '$';
    if (ref === '&') return match[0];
    if (name !== undefined) return match.groups ? (match.groups[name] ?? '') : token;
    if (Number(ref) >= 1 && Number(ref) < match.length) return match[Number(ref)] ?? '';
    // "$12" with fewer than 12 groups is group 1 followed by "2".
    if (ref.length === 2 && Number(ref[0]) >= 1 && Number(ref[0]) < match.length) return (match[Number(ref[0])] ?? '') + ref[1];
    return token;
});

// getText: () => the code. isReadonly: () => boolean (no replacing). syncLayers: re-syncs the
// mirrored layers' padding and scroll with the textarea.
const useFindReplace = ({ getText, textareaRef, isReadonly, syncLayers }) => {
    const findOpen = ref(false);
    const findShowReplace = ref(false);
    const findQuery = ref('');
    const findReplacement = ref('');
    const findCaseSensitive = ref(false);
    const findWholeWord = ref(false);
    const findUseRegex = ref(false);
    const findActiveIndex = ref(-1);
    const findStatus = ref(''); // a short-lived message, e.g. "Replaced 4"
    const findInputRef = ref(null);
    const replaceInputRef = ref(null);
    const findLayerRef = ref(null);
    const findProbeRef = ref(null);

    let anchor = 0; // when the matches change, the first one at or after this becomes active
    let lastSearchKey = null;
    let statusTimer = null;

    const search = computed(() => {
        if (!findOpen.value || !findQuery.value) return { regex: null, error: null };
        let source = findUseRegex.value ? findQuery.value : escapeRegex(findQuery.value);
        if (findWholeWord.value) source = `\\b(?:${source})\\b`;
        try {
            return { regex: new RegExp(source, 'gm' + (findCaseSensitive.value ? '' : 'i')), error: null };
        } catch (e) {
            return { regex: null, error: e.message };
        }
    });

    // [{ start, end }], empty matches skipped.
    const findMatches = computed(() => {
        const { regex } = search.value;
        if (!regex) return [];
        const text = getText();
        const found = [];
        regex.lastIndex = 0;
        let m;
        while (found.length < FIND_MATCH_LIMIT && (m = regex.exec(text))) {
            if (m[0] === '') {
                regex.lastIndex++;
                continue;
            }
            found.push({ start: m.index, end: m.index + m[0].length });
        }
        return found;
    });

    const findCountLabel = computed(() => {
        if (findStatus.value) return findStatus.value;
        if (search.value.error) return 'Invalid regex';
        if (!findQuery.value) return '';
        const n = findMatches.value.length;
        if (!n) return 'No results';
        const total = n >= FIND_MATCH_LIMIT ? `${n}+` : n;
        return findActiveIndex.value >= 0 ? `${findActiveIndex.value + 1} of ${total}` : `${total} found`;
    });

    const findLayerHTML = computed(() => {
        if (!findOpen.value) return '';
        const text = getText();
        let html = '';
        let last = 0;
        findMatches.value.forEach((m, i) => {
            const cls = i === findActiveIndex.value ? 'find-match active' : 'find-match';
            html += escapeHtml(text.slice(last, m.start)) + `<mark class="${cls}">${escapeHtml(text.slice(m.start, m.end))}</mark>`;
            last = m.end;
        });
        return html + escapeHtml(text.slice(last)) + '<br>';
    });

    const showStatus = (message) => {
        findStatus.value = message;
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => { findStatus.value = ''; }, FIND_STATUS_MS);
    };

    // Selects the active match in the textarea (without focusing it) and scrolls it into view:
    // first inside the textarea, then the page, since the editor grows with its code.
    const reveal = () => {
        const match = findMatches.value[findActiveIndex.value];
        const ta = textareaRef.value;
        if (!match || !ta) return;
        ta.setSelectionRange(match.start, match.end);
        nextTick(() => {
            const mark = findLayerRef.value?.querySelector('.find-match.active');
            if (!mark) return;
            const top = mark.offsetTop;
            const bottom = top + mark.offsetHeight;
            if (top < ta.scrollTop || bottom > ta.scrollTop + ta.clientHeight) {
                ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
            }
            syncLayers();
            const probe = findProbeRef.value;
            if (probe) {
                probe.style.top = `${top - ta.scrollTop}px`;
                probe.style.height = `${mark.offsetHeight}px`;
                probe.scrollIntoView({ block: 'nearest' });
            }
        });
    };

    // A new search (query or options) reveals its nearest match; edits to the code only keep
    // the active match in place.
    watch(findMatches, (list) => {
        if (!list.length) {
            findActiveIndex.value = -1;
        } else {
            const next = list.findIndex(m => m.start >= anchor);
            findActiveIndex.value = next === -1 ? 0 : next;
        }
        const key = `${findQuery.value}|${findCaseSensitive.value}|${findWholeWord.value}|${findUseRegex.value}`;
        if (key !== lastSearchKey) {
            lastSearchKey = key;
            findStatus.value = '';
            reveal();
        }
    });

    const findStep = (delta) => {
        const n = findMatches.value.length;
        if (!n) return;
        const current = findActiveIndex.value;
        findActiveIndex.value = current < 0 ? (delta > 0 ? 0 : n - 1) : (current + delta + n) % n;
        anchor = findMatches.value[findActiveIndex.value].start;
        reveal();
    };

    const focusFindInput = () => nextTick(() => {
        findInputRef.value?.focus();
        findInputRef.value?.select();
    });

    // A one-line selection becomes the query.
    const openFind = (withReplace = false) => {
        const ta = textareaRef.value;
        if (ta) {
            const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
            if (selected && !selected.includes('\n')) findQuery.value = findUseRegex.value ? escapeRegex(selected) : selected;
            anchor = ta.selectionStart;
        }
        findOpen.value = true;
        findShowReplace.value = withReplace && !isReadonly();
        nextTick(() => {
            syncLayers();
            reveal();
        });
        focusFindInput();
    };

    const closeFind = () => {
        findOpen.value = false;
        lastSearchKey = null;
        findStatus.value = '';
        // The textarea keeps the active match selected.
        textareaRef.value?.focus();
    };

    const toggleReplace = () => {
        if (isReadonly()) return;
        findShowReplace.value = !findShowReplace.value;
    };

    // Replaces start..end with text through the browser's editing commands, so it's undoable.
    const insertText = (start, end, text) => {
        const ta = textareaRef.value;
        ta.focus();
        ta.setSelectionRange(start, end);
        const done = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
        if (!done) {
            ta.setRangeText(text, start, end, 'end');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
    };

    // Runs the regex at the match itself (sticky), so anchors and lookarounds see the whole code.
    const replacementFor = (match) => {
        if (!findUseRegex.value) return findReplacement.value;
        const { regex } = search.value;
        const sticky = new RegExp(regex.source, regex.flags.replace('g', '') + 'y');
        sticky.lastIndex = match.start;
        const m = sticky.exec(getText());
        return m ? expandReplacement(findReplacement.value, m) : findReplacement.value;
    };

    const replaceOne = () => {
        if (isReadonly()) return;
        const match = findMatches.value[findActiveIndex.value];
        if (!match) return;
        const text = replacementFor(match);
        anchor = match.start + text.length;
        insertText(match.start, match.end, text);
        nextTick(() => {
            replaceInputRef.value?.focus();
            reveal();
        });
    };

    const replaceAll = () => {
        if (isReadonly() || !findMatches.value.length) return;
        const { regex } = search.value;
        const text = getText();
        let count = 0;
        regex.lastIndex = 0;
        const result = text.replace(regex, (...args) => {
            if (args[0] === '') return '';
            count++;
            if (!findUseRegex.value) return findReplacement.value;
            const hasNamedGroups = typeof args[args.length - 1] === 'object';
            const match = Object.assign(args.slice(0, hasNamedGroups ? -3 : -2), {
                groups: hasNamedGroups ? args[args.length - 1] : undefined,
            });
            return expandReplacement(findReplacement.value, match);
        });
        anchor = 0;
        insertText(0, text.length, result);
        showStatus(`Replaced ${count}`);
        nextTick(() => replaceInputRef.value?.focus());
    };

    // Shortcuts while the focus is in the panel.
    const handleFindKeydown = (e) => {
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        if (e.key === 'Escape') {
            e.preventDefault();
            closeFind();
        } else if (e.key === 'F3') {
            e.preventDefault();
            findStep(e.shiftKey ? -1 : 1);
        } else if (mod && !e.altKey && key === 'f') {
            e.preventDefault();
            focusFindInput();
        } else if (mod && !e.altKey && key === 'h') {
            e.preventDefault();
            if (isReadonly()) return;
            findShowReplace.value = true;
            nextTick(() => replaceInputRef.value?.focus());
        } else if (e.altKey && !mod && ['KeyC', 'KeyW', 'KeyR'].includes(e.code)) {
            // e.code, since Alt changes e.key on a Mac.
            e.preventDefault();
            if (e.code === 'KeyC') findCaseSensitive.value = !findCaseSensitive.value;
            if (e.code === 'KeyW') findWholeWord.value = !findWholeWord.value;
            if (e.code === 'KeyR') findUseRegex.value = !findUseRegex.value;
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (e.target === replaceInputRef.value) {
                if (mod && e.altKey) replaceAll();
                else replaceOne();
            } else {
                findStep(e.shiftKey ? -1 : 1);
            }
        }
    };

    // Shortcuts while the focus is in the textarea. Returns true when it handled the key.
    const handleEditorFindKeys = (e) => {
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        if (mod && !e.altKey && (key === 'f' || key === 'h')) {
            e.preventDefault();
            openFind(key === 'h');
            return true;
        }
        if (!findOpen.value) return false;
        if (e.key === 'F3') {
            e.preventDefault();
            findStep(e.shiftKey ? -1 : 1);
            return true;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            closeFind();
            return true;
        }
        return false;
    };

    onBeforeUnmount(() => clearTimeout(statusTimer));

    return {
        findOpen, findShowReplace, findQuery, findReplacement, findCaseSensitive, findWholeWord, findUseRegex,
        findError: computed(() => search.value.error), findMatches, findCountLabel, findLayerHTML,
        findInputRef, replaceInputRef, findLayerRef, findProbeRef,
        findStep, openFind, closeFind, toggleReplace, replaceOne, replaceAll,
        handleFindKeydown, handleEditorFindKeys,
    };
};
