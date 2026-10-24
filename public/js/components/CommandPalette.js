// The command palette (Ctrl+K): a search box over every command in the app, run with Enter or a
// click. The commands come from useCommandPalette; this only filters, ranks and picks them.
//
// A command: { id, label, group, hint?, run }. hint: its keyboard shortcut, shown at the right.


// --- Matching ---------------------------------------------------------------------------------

// How well a query fits a label, or null when it doesn't: every query character must appear in
// the label in order ("nsc" fits "New scope"). Characters that follow on from the previous match
// or start a word score more, so "new" ranks "New scope" above "Rename scope".
const commandMatchScore = (label, query) => {
    const text = label.toLowerCase();
    let score = 0;
    let from = 0;
    let previous = -2;
    for (const ch of query.toLowerCase()) {
        if (ch === ' ') {
            continue;
        }
        const index = text.indexOf(ch, from);
        if (index === -1) {
            return null;
        }

        const isWordStart = index === 0 || text[index - 1] === ' ' || text[index - 1] === ':';
        score += 1;
        if (index === previous + 1) {
            score += 3;
        }
        if (isWordStart) {
            score += 2;
        }
        previous = index;
        from = index + 1;
    }
    return score;
};

// The commands fitting a query, best first; all of them, in order, for an empty query.
const rankCommands = (commands, query) => {
    if (!query.trim()) {
        return commands;
    }

    const ranked = [];
    for (const command of commands) {
        const score = commandMatchScore(`${command.group}: ${command.label}`, query);
        if (score !== null) {
            ranked.push({ command, score });
        }
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.map(entry => entry.command);
};


// --- Component --------------------------------------------------------------------------------

const CommandPalette = {
    props: { commands: Array },
    emits: ['close', 'run'],
    setup(props, { emit }) {
        const query = ref('');
        const activeIndex = ref(0);
        const inputRef = ref(null);
        const listRef = ref(null);

        const results = computed(() => rankCommands(props.commands, query.value));

        watch(query, () => {
            activeIndex.value = 0;
        });

        const scrollActiveIntoView = () => {
            const row = listRef.value?.children[activeIndex.value];
            if (row) {
                row.scrollIntoView({ block: 'nearest' });
            }
        };

        const moveActive = (step) => {
            const count = results.value.length;
            if (!count) {
                return;
            }
            activeIndex.value = (activeIndex.value + step + count) % count;
            nextTick(scrollActiveIntoView);
        };

        const runCommand = (command) => {
            if (command) {
                emit('run', command);
            }
        };

        const handleKeydown = (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                moveActive(1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                moveActive(-1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                runCommand(results.value[activeIndex.value]);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                emit('close');
            }
        };

        onMounted(() => inputRef.value?.focus());

        return { query, activeIndex, inputRef, listRef, results, runCommand, handleKeydown };
    },
    template: `
        <div class="palette-backdrop" @mousedown.self="$emit('close')">
            <div class="palette" role="dialog" aria-label="Command palette">
                <div class="palette-search">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
                    <input ref="inputRef" v-model="query" placeholder="Type a command, a tab or a scope name…" spellcheck="false" @keydown="handleKeydown">
                    <kbd>Esc</kbd>
                </div>
                <div ref="listRef" class="palette-list">
                    <button v-for="(command, index) in results" :key="command.id" type="button"
                            class="palette-row" :class="{ active: index === activeIndex }"
                            @mousemove="activeIndex = index" @click="runCommand(command)">
                        <span class="palette-group">{{ command.group }}</span>
                        <span class="palette-label">{{ command.label }}</span>
                        <kbd v-if="command.hint">{{ command.hint }}</kbd>
                    </button>
                    <div v-if="!results.length" class="palette-empty">No commands match.</div>
                </div>
            </div>
        </div>
    `
};
