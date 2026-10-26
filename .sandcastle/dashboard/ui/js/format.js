// Formatting helpers shared by every view. All of them return plain strings;
// anything that goes into innerHTML is escaped here or by the caller.

export const escapeHtml = (value) => {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

// e.g. 4_500 -> "4s", 95_000 -> "1m 35s", 7_380_000 -> "2h 3m"
export const formatDuration = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) {
        return '–';
    }

    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
        return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
    }
    return `${seconds}s`;
};

// e.g. 950 -> "950", 12_400 -> "12.4k", 3_200_000 -> "3.2M"
export const formatTokens = (count) => {
    if (!count) {
        return '0';
    }
    if (count >= 1_000_000) {
        return `${(count / 1_000_000).toFixed(1)}M`;
    }
    if (count >= 1_000) {
        return `${(count / 1_000).toFixed(1)}k`;
    }
    return String(count);
};

export const formatCost = (usd) => {
    if (!usd) {
        return '$0.00';
    }
    return `$${usd.toFixed(2)}`;
};

// "19:30:12" in the viewer's local time.
export const formatClock = (iso) => {
    const date = new Date(iso);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
};

export const shortSha = (sha) => {
    return String(sha ?? '').slice(0, 7);
};

export const truncate = (text, max) => {
    const value = String(text ?? '');
    if (value.length <= max) {
        return value;
    }
    return `${value.slice(0, max - 1)}…`;
};

// The last path segment, e.g. "public/js/app.js" -> "app.js".
export const baseName = (path) => {
    const parts = String(path ?? '').split('/');
    return parts[parts.length - 1];
};

// --- Markdown ----------------------------------------------------------------

// Inline markup on already-escaped text: `code`, **bold**, *italic*.
const renderInline = (escaped) => {
    return escaped
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
};

const closeList = (html, state) => {
    if (state.inList) {
        html.push('</ul>');
        state.inList = false;
    }
};

const closeParagraph = (html, state) => {
    if (state.paragraph.length > 0) {
        html.push(`<p>${renderInline(state.paragraph.join(' '))}</p>`);
        state.paragraph = [];
    }
};

// A deliberately small Markdown renderer for agent messages: fenced code,
// headings, bullet lists, paragraphs and inline markup. The text is escaped
// first, so agent output can never inject HTML.
export const renderMarkdown = (text) => {
    const lines = escapeHtml(text).split('\n');
    const html = [];
    const state = { inList: false, inCode: false, paragraph: [] };

    for (const line of lines) {
        if (line.trim().startsWith('```')) {
            closeParagraph(html, state);
            closeList(html, state);
            html.push(state.inCode ? '</code></pre>' : '<pre class="md-code"><code>');
            state.inCode = !state.inCode;
            continue;
        }

        if (state.inCode) {
            html.push(`${line}\n`);
            continue;
        }

        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        const bullet = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);

        if (heading) {
            closeParagraph(html, state);
            closeList(html, state);
            html.push(`<h4>${renderInline(heading[2])}</h4>`);
        } else if (bullet) {
            closeParagraph(html, state);
            if (!state.inList) {
                html.push('<ul>');
                state.inList = true;
            }
            html.push(`<li>${renderInline(bullet[1])}</li>`);
        } else if (line.trim() === '') {
            closeParagraph(html, state);
            closeList(html, state);
        } else {
            closeList(html, state);
            state.paragraph.push(line);
        }
    }

    closeParagraph(html, state);
    closeList(html, state);
    if (state.inCode) {
        html.push('</code></pre>');
    }
    return html.join('');
};
