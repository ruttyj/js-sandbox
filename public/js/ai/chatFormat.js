// Claude's chat replies as HTML. Replies are Markdown-ish text; this handles the parts that matter
// in a short chat reply (code blocks, `inline code`, **bold**, and headings and lists by keeping
// the line breaks) and nothing else.
//
// Every character of the reply is HTML-escaped first, and only the few tags made here are added
// afterwards, so nothing in a reply (or in an item name it quotes) can inject markup.

const escapeChatHtml = (text) => {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

// Inline formatting within escaped text that isn't a code block.
// "**Profit** is `a - b`" -> "<strong>Profit</strong> is <code>a - b</code>"
const formatChatInline = (escaped) => {
    return escaped
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/^#{1,4} (.+)$/gm, '<strong>$1</strong>');
};

// ```js\ncode\n``` (the closing fence may be missing while a reply is still streaming).
const CHAT_CODE_FENCE = /```[\w-]*\n([\s\S]*?)(?:```|$)/g;

/**
 * @param {string} text  A reply, or as much of one as has streamed in.
 * @returns {string} Safe HTML; show it in an element with white-space: pre-wrap.
 */
const formatChatHtml = (text) => {
    const escaped = escapeChatHtml(text);
    let html = '';
    let lastIndex = 0;
    for (const match of escaped.matchAll(CHAT_CODE_FENCE)) {
        html += formatChatInline(escaped.slice(lastIndex, match.index));
        html += `<pre class="chat-code"><code>${match[1].replace(/\n$/, '')}</code></pre>`;
        lastIndex = match.index + match[0].length;
    }
    html += formatChatInline(escaped.slice(lastIndex));
    return html;
};
