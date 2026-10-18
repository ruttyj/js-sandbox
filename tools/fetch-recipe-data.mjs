// Downloads every recipe on the OSRS wiki into data/raw/recipes.json: the rows of the wiki's
// "recipe" bucket (see https://oldschool.runescape.wiki/w/Bucket:Recipe). Each row is one way of
// making something, from a {{Recipe}} template on an item's page:
//   { page, production }   production: the template's data (materials, output, skills, ...)
//
// Usage: node tools/fetch-recipe-data.mjs
// Then:  node tools/build-item-recipes.mjs   (also needs data/raw/items.json)
// Needs Node 18+ (global fetch). Pages of rows are requested one at a time, as the wiki's API
// etiquette asks.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USER_AGENT = 'osrs-ge-tracker item tagging - https://github.com/ruttyj/js-sandbox';
const WIKI_API_URL = 'https://oldschool.runescape.wiki/api.php';
const ROWS_PER_REQUEST = 5000;

const outputFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'raw', 'recipes.json');

// --- Requests ---------------------------------------------------------------------------------

const fetchJson = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} for ${url}`);
    }
    return response.json();
};

// One page of the recipe bucket, oldest rows first.
const recipeBucketUrl = (offset) => {
    const query = "bucket('recipe')"
        + ".select('page_name','source_template','production_json')"
        + `.limit(${ROWS_PER_REQUEST}).offset(${offset}).run()`;
    const params = new URLSearchParams({ action: 'bucket', format: 'json', query });
    return `${WIKI_API_URL}?${params}`;
};

const fetchRecipeRows = async () => {
    const rows = [];
    for (let offset = 0; ; offset += ROWS_PER_REQUEST) {
        const result = await fetchJson(recipeBucketUrl(offset));
        if (result.error) {
            throw new Error(`wiki bucket query failed: ${result.error}`);
        }

        rows.push(...result.bucket);
        process.stdout.write(`\rrecipe rows: ${rows.length}`);
        if (result.bucket.length < ROWS_PER_REQUEST) {
            break;
        }
    }
    process.stdout.write('\n');
    return rows;
};

// --- Main -------------------------------------------------------------------------------------

// Rows from {{Skill info}} describe activities (an agility course, a rock to mine) rather than
// something made from materials; they have no output, so only {{Recipe}} rows are kept.
const toRecipe = (row) => ({
    page: row.page_name,
    production: JSON.parse(row.production_json),
});

const main = async () => {
    const rows = await fetchRecipeRows();
    const recipes = rows
        .filter(row => row.source_template === 'recipe')
        .map(toRecipe)
        .filter(recipe => recipe.production.output);

    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, JSON.stringify(recipes, null, 1));
    console.log(`recipes: ${recipes.length} (of ${rows.length} rows)`);
    console.log(`wrote ${outputFile}`);
};

main().catch(error => {
    console.error(error);
    process.exit(1);
});
