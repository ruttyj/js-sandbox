// The Changes tab: the agent's real diff, read from git by the server. While
// the agent runs this is its live worktree (uncommitted edits included), so
// it shows what the code actually looks like now, not just what the feed's
// Edit calls said.

import { parsePatch, renderPatchFile } from './diff.js';
import { escapeHtml, formatDuration, shortSha } from './format.js';
import { icon } from './icons.js';

const STATUS_LETTERS = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

const SOURCE_LABELS = {
    worktree: 'Live worktree · includes uncommitted edits',
    branch: 'Committed work on the branch',
    none: 'No branch to diff',
};

// Fetches the agent's changes. Returns { data, files } or throws.
export const fetchChanges = async (agentId) => {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/changes`);
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
    }
    return { data, files: parsePatch(data.patch) };
};

const splitPath = (path) => {
    const slash = path.lastIndexOf('/');
    if (slash === -1) {
        return { dir: '', name: path };
    }
    return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
};

// A small green/red bar proportional to the lines added and removed.
const churnBar = (file) => {
    const total = file.additions + file.deletions;
    if (total === 0) {
        return '<span class="churn"></span>';
    }
    const addWidth = Math.round((file.additions / total) * 100);
    return `<span class="churn"><span class="churn-add" style="width:${addWidth}%"></span><span class="churn-del" style="width:${100 - addWidth}%"></span></span>`;
};

const renderFileRow = (file, selectedPath) => {
    const { dir, name } = splitPath(file.path);
    const selected = file.path === selectedPath ? ' is-selected' : '';
    const letter = STATUS_LETTERS[file.status] ?? 'M';

    return `<button class="change-file${selected}" data-action="select-file" data-path="${escapeHtml(file.path)}" data-key="${escapeHtml(file.path)}" title="${escapeHtml(file.path)}">`
        + `<span class="change-status change-${file.status}">${letter}</span>`
        + `<span class="change-name"><span class="change-dir">${escapeHtml(dir)}</span>${escapeHtml(name)}</span>`
        + `<span class="change-counts"><span class="add">+${file.additions}</span><span class="del">−${file.deletions}</span></span>`
        + churnBar(file)
        + '</button>';
};

const renderCommits = (commits, repoUrl) => {
    if (commits.length === 0) {
        return '';
    }

    const rows = [];
    for (const commit of commits) {
        let sha = `<code>${escapeHtml(shortSha(commit.sha))}</code>`;
        if (repoUrl) {
            sha = `<a href="${escapeHtml(`${repoUrl}/commit/${commit.sha}`)}" target="_blank" rel="noreferrer"><code>${escapeHtml(shortSha(commit.sha))}</code></a>`;
        }
        rows.push(`<li>${icon('gitCommit', 13)}${sha}<span>${escapeHtml(commit.subject)}</span></li>`);
    }
    return `<ul class="commit-list">${rows.join('')}</ul>`;
};

const renderSummary = (entry, now) => {
    let additions = 0;
    let deletions = 0;
    for (const file of entry.files) {
        additions += file.additions;
        deletions += file.deletions;
    }

    const source = entry.data.source;
    const updated = entry.fetchedAt ? `updated ${formatDuration(now - entry.fetchedAt)} ago` : '';
    const spinner = entry.loading ? '<span class="spinner"></span>' : '';
    const truncated = entry.data.truncated ? '<span class="chip chip-warn">diff truncated</span>' : '';

    return '<div class="changes-summary">'
        + `<span class="chip source-${source}">${icon(source === 'worktree' ? 'eye' : 'gitBranch', 12)} ${SOURCE_LABELS[source]}</span>`
        + `<span class="changes-totals"><strong>${entry.files.length}</strong> files <span class="add">+${additions}</span> <span class="del">−${deletions}</span></span>`
        + truncated
        + `<span class="changes-updated">${spinner}${updated}</span>`
        + `<button class="btn btn-ghost btn-small" data-action="refresh-changes">${icon('refresh', 12)} Refresh</button>`
        + '</div>';
};

// entry: { loading, error, data, files, fetchedAt } from main.js, or
// undefined before the first fetch.
export const renderChangesTab = (entry, selectedPath, repoUrl, now) => {
    if (!entry || (!entry.data && entry.loading)) {
        return '<div class="empty"><span class="spinner"></span><div>Reading the diff from git…</div></div>';
    }

    if (!entry.data) {
        return `<div class="empty">${icon('alert', 20)}<div>Couldn't read the changes</div><small>${escapeHtml(entry.error ?? '')}</small></div>`;
    }

    if (entry.files.length === 0) {
        return renderSummary(entry, now)
            + renderCommits(entry.data.commits, repoUrl)
            + `<div class="empty">${icon('file', 20)}<div>No changes yet</div><small>Edits show up here as soon as the agent saves them.</small></div>`;
    }

    const selected = entry.files.find((file) => file.path === selectedPath) ?? entry.files[0];
    const fileRows = entry.files.map((file) => renderFileRow(file, selected.path));

    return renderSummary(entry, now)
        + renderCommits(entry.data.commits, repoUrl)
        + '<div class="changes-body">'
        + `<nav class="change-files">${fileRows.join('')}</nav>`
        + '<div class="change-view">'
        + `<div class="change-view-head"><span class="change-status change-${selected.status}">${STATUS_LETTERS[selected.status]}</span>${escapeHtml(selected.path)}`
        + `<span class="change-counts"><span class="add">+${selected.additions}</span><span class="del">−${selected.deletions}</span></span></div>`
        + `<div class="change-diff">${renderPatchFile(selected)}</div>`
        + '</div>'
        + '</div>';
};
