// The live activity stream for one agent: what it says, every tool call with
// its result, the edits it makes as diffs, test runs and commits.
//
// Agents produce thousands of items, so the feed isn't re-rendered as a
// whole: new items are appended and an item is replaced only when its `rev`
// changes (a tool call getting its result).

import { renderLineDiff } from './diff.js';
import { escapeHtml, formatClock, formatDuration, renderMarkdown, shortSha } from './format.js';
import { icon } from './icons.js';
import { describeTool } from './tools.js';

// Within this many pixels of the bottom counts as "following" the stream.
const FOLLOW_THRESHOLD_PX = 80;

// What each feed filter shows; see data-kind on the items.
const KIND_BY_TOOL = {
    Edit: 'edit',
    MultiEdit: 'edit',
    Write: 'edit',
    NotebookEdit: 'edit',
    Bash: 'command',
    Read: 'read',
    Grep: 'read',
    Glob: 'read',
};

// --- Tool bodies -------------------------------------------------------------

const renderOutput = (result) => {
    if (!result) {
        return '<div class="tool-pending">Waiting for result…</div>';
    }

    if (result.output.trim() === '') {
        return '<div class="tool-pending">(no output)</div>';
    }

    const errorClass = result.isError ? ' is-error' : '';
    return `<pre class="tool-output${errorClass}">${escapeHtml(result.output)}</pre>`;
};

// The checklist an agent keeps with TodoWrite; also used by the Plan tab.
export const renderTodos = (todos, extraClass = '') => {
    const items = [];
    for (const todo of todos ?? []) {
        let mark = '○';
        if (todo.status === 'completed') {
            mark = icon('check', 13);
        } else if (todo.status === 'in_progress') {
            mark = '◐';
        }
        items.push(`<li class="todo todo-${escapeHtml(todo.status)}"><span class="todo-mark">${mark}</span>${escapeHtml(todo.content)}</li>`);
    }
    return `<ul class="todo-list ${extraClass}">${items.join('')}</ul>`;
};

const renderEditBody = (item) => {
    const input = item.input ?? {};

    if (item.name === 'MultiEdit' && Array.isArray(input.edits)) {
        const diffs = input.edits.map((edit) => renderLineDiff(edit.old_string ?? '', edit.new_string ?? ''));
        return diffs.join('<div class="diff-gap"></div>');
    }

    if (item.name === 'Write') {
        return renderLineDiff('', input.content ?? '');
    }

    return renderLineDiff(input.old_string ?? '', input.new_string ?? '');
};

const renderToolBody = (item) => {
    const input = item.input ?? {};
    const failed = item.result?.isError;

    if (KIND_BY_TOOL[item.name] === 'edit') {
        let errorNote = '';
        if (failed) {
            errorNote = renderOutput(item.result);
        }
        return `<div class="tool-diff">${renderEditBody(item)}</div>${errorNote}`;
    }

    if (item.name === 'TodoWrite') {
        return renderTodos(input.todos);
    }

    if (item.name === 'Bash') {
        return `<pre class="term"><span class="term-prompt">$</span> ${escapeHtml(input.command ?? '')}</pre>${renderOutput(item.result)}`;
    }

    if (item.name === 'Read' || item.name === 'Grep' || item.name === 'Glob') {
        return renderOutput(item.result);
    }

    return `<pre class="tool-input">${escapeHtml(JSON.stringify(input, null, 2))}</pre>${renderOutput(item.result)}`;
};

// --- Tool header -------------------------------------------------------------

const renderToolBadges = (item) => {
    const badges = [];

    if (item.tests) {
        if (item.tests.failed > 0) {
            badges.push(`<span class="badge badge-danger">${icon('flask', 12)} ${item.tests.failed} failed</span>`);
        } else {
            badges.push(`<span class="badge badge-success">${icon('flask', 12)} ${item.tests.passed} passed</span>`);
        }
    }

    if (item.commit) {
        badges.push(`<span class="badge badge-accent">${icon('gitCommit', 12)} ${escapeHtml(shortSha(item.commit.sha))}</span>`);
    }

    if (item.result?.isError && !item.tests) {
        badges.push('<span class="badge badge-danger">error</span>');
    }
    return badges.join('');
};

const renderToolTiming = (item) => {
    if (!item.result) {
        return '<span class="tool-time is-running"><span class="spinner"></span></span>';
    }
    return `<span class="tool-time">${formatDuration(item.result.time - item.time)}</span>`;
};

// Edits and plans are what a supervisor most wants to see, so they start
// expanded; command output and file contents start collapsed.
const startsOpen = (item) => {
    return KIND_BY_TOOL[item.name] === 'edit' || item.name === 'TodoWrite';
};

const toolState = (item) => {
    if (!item.result) {
        return 'running';
    }
    if (item.result.isError) {
        return 'error';
    }
    return 'ok';
};

const renderTool = (item) => {
    const { icon: iconName, verb, target, detail } = describeTool(item.name, item.input);
    const state = toolState(item);
    const detailHtml = detail ? `<span class="tool-detail">${escapeHtml(detail)}</span>` : '';
    const open = startsOpen(item) ? ' open' : '';

    return `<details class="tool tool-${state}"${open}>`
        + '<summary class="tool-head">'
        + `<span class="tool-icon">${icon(iconName, 14)}</span>`
        + `<span class="tool-verb">${escapeHtml(verb)}</span>`
        + `<span class="tool-target" title="${escapeHtml(target)}">${escapeHtml(target)}</span>`
        + detailHtml
        + `<span class="tool-badges">${renderToolBadges(item)}</span>`
        + renderToolTiming(item)
        + '</summary>'
        + `<div class="tool-body">${renderToolBody(item)}</div>`
        + '</details>';
};

// --- Other items -------------------------------------------------------------

const renderEnd = (item) => {
    let title = `Finished with ${item.commits.length} commit(s)`;
    let iconName = 'check';
    if (item.status === 'failed') {
        title = 'Failed';
        iconName = 'alert';
    } else if (item.status === 'aborted') {
        title = 'Aborted from the dashboard';
        iconName = 'square';
    }

    const error = item.error ? `<pre class="tool-output is-error">${escapeHtml(item.error)}</pre>` : '';
    return `<div class="feed-end feed-end-${item.status}">${icon(iconName, 16)}<strong>${escapeHtml(title)}</strong></div>${error}`;
};

const renderItemContent = (item) => {
    switch (item.type) {
        case 'turn':
            return `<div class="feed-turn"><span>Iteration ${item.turn} / ${item.maxTurns}</span></div>`;
        case 'status':
            return `<div class="feed-status${item.isError ? ' is-error' : ''}"><span class="feed-status-dot"></span>${escapeHtml(item.text)}</div>`;
        case 'text':
            return `<div class="feed-text"><span class="feed-avatar">${icon('sparkle', 14)}</span><div class="md">${renderMarkdown(item.text)}</div></div>`;
        case 'thinking':
            return `<details class="feed-thinking"><summary>${icon('sparkle', 12)} Thinking</summary><div class="feed-thinking-body">${escapeHtml(item.text)}</div></details>`;
        case 'tool':
            return renderTool(item);
        case 'end':
            return renderEnd(item);
        default:
            return '';
    }
};

const itemKind = (item) => {
    if (item.type === 'text' || item.type === 'thinking') {
        return 'message';
    }
    if (item.type === 'tool') {
        return KIND_BY_TOOL[item.name] ?? 'other';
    }
    return 'system';
};

const isErrorItem = (item) => {
    return Boolean(item.result?.isError || item.isError || item.status === 'failed' || item.tests?.failed);
};

const createItemNode = (item) => {
    const node = document.createElement('div');
    node.className = `feed-item feed-${item.type}-item`;
    node.dataset.kind = itemKind(item);
    if (isErrorItem(item)) {
        node.dataset.error = '1';
    }
    node.title = formatClock(item.time);
    node.innerHTML = renderItemContent(item);
    return node;
};

// --- Feed view ---------------------------------------------------------------

export class FeedView {
    // onFollowChange(following) is called when the user scrolls away from,
    // or back to, the bottom of the stream.
    constructor(container, onFollowChange) {
        this.container = container;
        this.onFollowChange = onFollowChange;
        this.agentId = null;
        this.renderedFeedRev = -1;
        this.nodes = new Map();
        this.revs = new Map();
        this.following = true;
        container.addEventListener('scroll', () => this.updateFollowing());
    }

    updateFollowing() {
        const { scrollHeight, scrollTop, clientHeight } = this.container;
        const following = scrollHeight - scrollTop - clientHeight < FOLLOW_THRESHOLD_PX;
        if (following !== this.following) {
            this.following = following;
            this.onFollowChange(following);
        }
    }

    scrollToLatest() {
        this.container.scrollTop = this.container.scrollHeight;
        this.updateFollowing();
    }

    reset(agentId) {
        this.agentId = agentId;
        this.renderedFeedRev = -1;
        this.nodes.clear();
        this.revs.clear();
        this.container.replaceChildren();
        this.following = true;
        this.onFollowChange(true);
    }

    render(agent) {
        if (agent.id !== this.agentId) {
            this.reset(agent.id);
        }

        if (agent.feedRev === this.renderedFeedRev) {
            return;
        }

        const fragment = document.createDocumentFragment();
        for (const item of agent.feed) {
            this.renderItem(item, fragment);
        }
        this.container.appendChild(fragment);
        this.renderedFeedRev = agent.feedRev;

        if (this.following) {
            this.container.scrollTop = this.container.scrollHeight;
        }
    }

    renderItem(item, fragment) {
        const renderedRev = this.revs.get(item.key);
        if (renderedRev === item.rev) {
            return;
        }

        const node = createItemNode(item);
        const existing = this.nodes.get(item.key);
        if (existing) {
            // Keep whatever the user expanded or collapsed.
            const wasOpen = existing.querySelector('details')?.open;
            const details = node.querySelector('details');
            if (details && wasOpen !== undefined) {
                details.open = wasOpen;
            }
            existing.replaceWith(node);
        } else {
            fragment.appendChild(node);
        }

        this.nodes.set(item.key, node);
        this.revs.set(item.key, item.rev);
    }
}
