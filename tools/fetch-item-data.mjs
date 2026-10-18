// Downloads the raw OSRS item data the item tags are built from, into data/raw/:
//   items.json       every GE item: mapping fields (examine, members, limit, alch values, ...),
//                    its daily trade volume, its wiki page title and that page's categories
//   categories.json  every wiki category seen, with how many items carry it (most common first)
//
// Usage: node tools/fetch-item-data.mjs
// Needs Node 18+ (global fetch). Wiki requests are batched (50 titles each) and run one at a
// time, as the wiki's API etiquette asks.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USER_AGENT = 'osrs-ge-tracker item tagging - https://github.com/ruttyj/js-sandbox';
const MAPPING_URL = 'https://prices.runescape.wiki/api/v1/osrs/mapping';
const VOLUMES_URL = 'https://prices.runescape.wiki/api/v1/osrs/volumes';
const WIKI_API_URL = 'https://oldschool.runescape.wiki/api.php';
const TITLES_PER_REQUEST = 50;

// Categories every item page has, or that only describe the wiki itself; they say nothing
// about what an item is.
const IGNORED_CATEGORIES = new Set([
    'Items',
    'Grand Exchange items',
    'Tradeable items',
]);

const outputDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'raw');

// --- Requests ---------------------------------------------------------------------------------

const fetchJson = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} for ${url}`);
    }
    return response.json();
};

const categoriesUrl = (titles, continueParams) => {
    const params = new URLSearchParams({
        action: 'query',
        prop: 'categories',
        titles: titles.join('|'),
        cllimit: 'max',
        clshow: '!hidden',
        redirects: '1',
        format: 'json',
        ...continueParams,
    });
    return `${WIKI_API_URL}?${params}`;
};

// --- Wiki categories --------------------------------------------------------------------------

// Where each requested title ended up after the API's normalisation and redirects.
// Returns Map<requested title, final page title>.
const resolveTitles = (titles, query) => {
    const renamed = new Map();
    for (const step of [...(query.normalized || []), ...(query.redirects || [])]) {
        renamed.set(step.from, step.to);
    }

    const finalTitles = new Map();
    for (const title of titles) {
        let current = title;
        const seen = new Set();
        while (renamed.has(current) && !seen.has(current)) {
            seen.add(current);
            current = renamed.get(current);
        }
        finalTitles.set(title, current);
    }
    return finalTitles;
};

const categoryName = (category) => category.title.replace(/^Category:/, '');

// Categories for one batch of titles. Long category lists come back in several pages
// (the "continue" parameters), so this keeps asking until the batch is complete.
// Returns { pageTitles: Map<requested title, page title>, categories: Map<page title, string[]> }.
const fetchCategoryBatch = async (titles) => {
    const categories = new Map();
    let pageTitles = null;
    let continueParams = {};

    while (true) {
        const result = await fetchJson(categoriesUrl(titles, continueParams));
        if (!pageTitles) {
            pageTitles = resolveTitles(titles, result.query);
        }

        for (const page of Object.values(result.query.pages)) {
            if (page.missing !== undefined) {
                continue;
            }
            const names = (page.categories || []).map(categoryName);
            categories.set(page.title, [...(categories.get(page.title) || []), ...names]);
        }

        if (!result.continue) {
            break;
        }
        continueParams = result.continue;
    }

    return { pageTitles, categories };
};

// --- Main -------------------------------------------------------------------------------------

const fetchAllCategories = async (titles) => {
    const pageTitles = new Map();
    const categories = new Map();

    for (let i = 0; i < titles.length; i += TITLES_PER_REQUEST) {
        const batch = titles.slice(i, i + TITLES_PER_REQUEST);
        const result = await fetchCategoryBatch(batch);
        result.pageTitles.forEach((page, title) => pageTitles.set(title, page));
        result.categories.forEach((names, page) => categories.set(page, names));
        process.stdout.write(`\rwiki categories: ${Math.min(i + TITLES_PER_REQUEST, titles.length)} / ${titles.length}`);
    }
    process.stdout.write('\n');

    return { pageTitles, categories };
};

const countCategories = (items) => {
    const counts = new Map();
    for (const item of items) {
        for (const category of item.categories) {
            counts.set(category, (counts.get(category) || 0) + 1);
        }
    }
    return [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, count]) => ({ name, count }));
};

const main = async () => {
    const mapping = await fetchJson(MAPPING_URL);
    const volumes = (await fetchJson(VOLUMES_URL)).data || {};
    console.log(`items: ${mapping.length}`);

    const names = [...new Set(mapping.map(entry => entry.name))];
    const { pageTitles, categories } = await fetchAllCategories(names);

    const items = mapping
        .map(entry => {
            const wikiTitle = pageTitles.get(entry.name) || null;
            const pageCategories = (wikiTitle && categories.get(wikiTitle)) || [];
            return {
                ...entry,
                volume: volumes[entry.id] ?? null,
                wikiTitle: categories.has(wikiTitle) ? wikiTitle : null,
                categories: [...new Set(pageCategories)].filter(name => !IGNORED_CATEGORIES.has(name)),
            };
        })
        .sort((a, b) => a.id - b.id);

    const missingPages = items.filter(item => !item.wikiTitle).length;
    console.log(`items without a wiki page: ${missingPages}`);

    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'items.json'), JSON.stringify(items, null, 1));
    await writeFile(join(outputDir, 'categories.json'), JSON.stringify(countCategories(items), null, 1));
    console.log(`wrote ${join(outputDir, 'items.json')} and categories.json`);
};

main().catch(error => {
    console.error(error);
    process.exit(1);
});
