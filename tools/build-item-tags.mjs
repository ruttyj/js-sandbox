// Builds public/data/itemTagData.js (the app's built-in item tags) from the tag proposals.
//
//   node tools/build-item-tags.mjs           build, and print a summary
//   node tools/build-item-tags.mjs --report  also print every tag's item count
//
// Reads data/raw/items.json (from tools/fetch-item-data.mjs), every
// public/data/tagging/proposals/*.json, and public/data/tagging/merge.json (how conflicts between proposals
// are settled). See public/data/tagging/README.md for the proposal format and matching rules.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const proposalsDir = join(projectRoot, 'public', 'data', 'tagging', 'proposals');
const outputFile = join(projectRoot, 'public', 'data', 'itemTagData.js');

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

// --- Loading ----------------------------------------------------------------------------------

const loadProposals = async (merge) => {
    const files = (await readdir(proposalsDir)).filter(name => name.endsWith('.json')).sort();
    const proposals = [];
    for (const file of files) {
        const proposal = await readJson(join(proposalsDir, file));
        const domain = proposal.domain || file.replace(/\.json$/, '');
        const renames = merge.renameKeys?.[domain] || {};
        const rename = (key) => (key && renames[key]) || key;
        const tags = proposal.tags.map(tag => ({ ...tag, key: rename(tag.key), parent: rename(tag.parent) || null }));
        proposals.push({ domain, tags });
    }
    return proposals;
};

// --- Merging the tag tree ---------------------------------------------------------------------

// Collects every definition of each key: Map<key, { labels, descriptions, parents, matches }>.
const collectDefinitions = (proposals, merge) => {
    const definitions = new Map();
    const definitionFor = (key) => {
        if (!definitions.has(key)) {
            definitions.set(key, { labels: [], descriptions: [], parents: new Set(), matches: [] });
        }
        return definitions.get(key);
    };

    for (const root of merge.roots) {
        const definition = definitionFor(root.key);
        definition.labels.push(root.label);
        definition.parents.add(root.parent);
    }

    for (const proposal of proposals) {
        for (const tag of proposal.tags) {
            const definition = definitionFor(tag.key);
            if (tag.label) {
                definition.labels.push(tag.label);
            }
            if (tag.description) {
                definition.descriptions.push(tag.description);
            }
            definition.parents.add(tag.parent || null);
            if (tag.match) {
                definition.matches.push(tag.match);
            }
        }
    }
    return definitions;
};

// The candidate parents' ancestors, following each candidate's first-listed parent.
const ancestorsVia = (definitions, key) => {
    const seen = [];
    let current = key;
    while (current && !seen.includes(current) && definitions.has(current)) {
        seen.push(current);
        current = [...definitions.get(current).parents].find(Boolean) || null;
    }
    return seen;
};

// One parent per tag: merge.json's choice, else the most specific candidate (one that has the
// other candidates among its ancestors), else the first listed. Returns { parent, conflict }.
const chooseParent = (definitions, key, merge) => {
    if (merge.parents?.[key] !== undefined) {
        return { parent: merge.parents[key], conflict: false };
    }
    const candidates = [...definitions.get(key).parents].filter(parent => parent !== key);
    const real = candidates.filter(Boolean);
    if (real.length <= 1) {
        return { parent: real[0] || null, conflict: false };
    }
    for (const candidate of real) {
        const ancestors = ancestorsVia(definitions, candidate);
        if (real.every(other => ancestors.includes(other))) {
            return { parent: candidate, conflict: false };
        }
    }
    return { parent: real[0], conflict: true };
};

// Final tag list: [{ key, label, parent, description, matches }]. Parents that no proposal
// defines become root tags with a label made from the key.
const buildTags = (definitions, merge) => {
    const conflicts = [];
    const tags = new Map();
    for (const [key, definition] of definitions) {
        const { parent, conflict } = chooseParent(definitions, key, merge);
        if (conflict) {
            conflicts.push(`${key}: ${[...definition.parents].join(' / ')} -> ${parent}`);
        }
        tags.set(key, {
            key,
            label: merge.labels?.[key] || definition.labels[0] || key,
            parent,
            description: definition.descriptions[0] || '',
            matches: definition.matches,
        });
    }

    const missingParents = new Set();
    for (const tag of tags.values()) {
        if (tag.parent && !tags.has(tag.parent)) {
            missingParents.add(tag.parent);
        }
    }
    for (const key of missingParents) {
        const label = key.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
        tags.set(key, { key, label, parent: null, description: '', matches: [] });
    }
    return { tags, conflicts, missingParents: [...missingParents] };
};

// --- Applying the rules -----------------------------------------------------------------------

const compileMatch = (match) => ({
    categoriesAny: new Set(match.categoriesAny || []),
    categoriesAll: match.categoriesAll || [],
    nameRegex: match.nameRegex ? new RegExp(match.nameRegex, 'i') : null,
    excludeNameRegex: match.excludeNameRegex ? new RegExp(match.excludeNameRegex, 'i') : null,
    ids: new Set((match.ids || []).map(Number)),
});

// The README's rule: any of categoriesAny / nameRegex / ids, and every categoriesAll, and not
// excludeNameRegex.
const matchesItem = (rule, item) => {
    const hitsAny = item.categories.some(category => rule.categoriesAny.has(category))
        || Boolean(rule.nameRegex && rule.nameRegex.test(item.name))
        || rule.ids.has(item.id);
    if (!hitsAny) {
        return false;
    }
    const hasAll = rule.categoriesAll.every(category => item.categories.includes(category));
    const excluded = Boolean(rule.excludeNameRegex && rule.excludeNameRegex.test(item.name));
    return hasAll && !excluded;
};

const lineageOf = (tags, key) => {
    const lineage = [];
    let current = key;
    while (current && !lineage.includes(current)) {
        lineage.push(current);
        current = tags.get(current)?.parent || null;
    }
    return lineage;
};

// Keeps only an item's most specific tags: an ancestor of another of its tags is implied.
const mostSpecific = (tags, keys) => {
    const implied = new Set();
    for (const key of keys) {
        for (const ancestor of lineageOf(tags, key).slice(1)) {
            implied.add(ancestor);
        }
    }
    return keys.filter(key => !implied.has(key));
};

// { [itemId]: [key, ...] }, keys sorted for stable output.
const tagItems = (tags, items) => {
    const rules = [...tags.values()].map(tag => ({ key: tag.key, rules: tag.matches.map(compileMatch) }));
    const byItem = {};
    for (const item of items) {
        const keys = rules
            .filter(({ rules: tagRules }) => tagRules.some(rule => matchesItem(rule, item)))
            .map(({ key }) => key);
        const own = mostSpecific(tags, keys).sort();
        if (own.length) {
            byItem[item.id] = own;
        }
    }
    return byItem;
};

// --- Output -----------------------------------------------------------------------------------

const countItems = (tags, byItem) => {
    const counts = new Map();
    for (const keys of Object.values(byItem)) {
        const expanded = new Set(keys.flatMap(key => lineageOf(tags, key)));
        for (const key of expanded) {
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }
    return counts;
};

const renderDataFile = (tags, byItem) => {
    const tagList = [...tags.values()]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(({ key, label, parent, description }) => ({ key, label, parent, description }));
    const itemLines = Object.entries(byItem).map(([id, keys]) => `        ${id}: ${JSON.stringify(keys)},`);
    const tagLines = tagList.map(tag => `        ${JSON.stringify(tag)},`);
    return [
        '// Built-in item tags, generated from the OSRS wiki by tools/build-item-tags.mjs (see',
        "// data/tagging/README.md). Don't edit by hand: the user's own tag changes are saved",
        '// separately and layered on top (see js/utils/itemTags.js).',
        '//   tags:  [{ key, label, parent, description }]',
        "//   items: { [itemId]: [tagKey, ...] }   an item's own tags; ancestors are implied",
        "// It's a script rather than JSON so the app also works when index.html is opened as a file.",
        'const BUILTIN_ITEM_TAG_DATA = {',
        '    tags: [',
        ...tagLines,
        '    ],',
        '    items: {',
        ...itemLines,
        '    },',
        '};',
        '',
    ].join('\n');
};

const main = async () => {
    const showReport = process.argv.includes('--report');
    const merge = await readJson(join(projectRoot, 'public', 'data', 'tagging', 'merge.json'));
    const items = await readJson(join(projectRoot, 'data', 'raw', 'items.json'));
    const proposals = await loadProposals(merge);

    const definitions = collectDefinitions(proposals, merge);
    const { tags, conflicts, missingParents } = buildTags(definitions, merge);
    const byItem = tagItems(tags, items);
    await writeFile(outputFile, renderDataFile(tags, byItem));

    const counts = countItems(tags, byItem);
    const emptyTags = [...tags.keys()].filter(key => !counts.get(key));
    console.log(`proposals: ${proposals.map(p => p.domain).join(', ')}`);
    console.log(`tags: ${tags.size}, tagged items: ${Object.keys(byItem).length} / ${items.length}`);
    console.log(`parent conflicts settled by order (add them to merge.json): ${conflicts.length ? '\n  ' + conflicts.join('\n  ') : 'none'}`);
    console.log(`parents no proposal defines (made roots): ${missingParents.join(', ') || 'none'}`);
    console.log(`tags with no items: ${emptyTags.join(', ') || 'none'}`);
    if (showReport) {
        for (const tag of [...tags.values()].sort((a, b) => a.key.localeCompare(b.key))) {
            console.log(`${String(counts.get(tag.key) || 0).padStart(5)}  ${tag.key}  (${tag.parent || 'root'})`);
        }
    }
    console.log(`wrote ${outputFile}`);
};

main().catch(error => {
    console.error(error);
    process.exit(1);
});
