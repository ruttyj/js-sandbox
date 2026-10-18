// Builds data/itemRecipeData.js (the app's built-in recipes) from the wiki's recipe data.
//
//   node tools/build-item-recipes.mjs
//
// Reads data/raw/recipes.json (from tools/fetch-recipe-data.mjs) and data/raw/items.json (from
// tools/fetch-item-data.mjs), and turns each recipe's materials and output into GE item IDs where
// they are GE items. Everything else (coins, untradeable intermediates like "Yew seedling (w)")
// is kept by name, so the app can follow a chain through it.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = join(projectRoot, 'data', 'raw');
const outputFile = join(projectRoot, 'data', 'itemRecipeData.js');

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

// --- Values -----------------------------------------------------------------------------------

// "2", "0.46" and ".46" as numbers; anything else ("Varies", "4×Crafting level", "") as null.
const numberOrNull = (text) => {
    const isNumber = /^(\d+(\.\d+)?|\.\d+)$/.test(String(text ?? '').trim());
    if (!isNumber) {
        return null;
    }
    return Number(text);
};

// Tools and facilities are one string of wiki text: "[[Hammer]], Ammo mould" -> ['Hammer', 'Ammo mould'].
const nameList = (text) => {
    if (typeof text !== 'string') {
        return [];
    }

    const names = [];
    for (const part of text.split(',')) {
        const name = part.replace(/\[\[|\]\]/g, '').trim();
        if (name) {
            names.push(name);
        }
    }
    return names;
};

const imageStem = (image) => String(image || '').replace(/\.(png|gif)$/i, '');

// --- Finding GE items -------------------------------------------------------------------------

// Wiki icon file name (without extension, lowercase) -> the GE items using it.
const itemsByIcon = (items) => {
    const byIcon = new Map();
    for (const item of items) {
        const key = imageStem(item.icon).toLowerCase();
        if (!byIcon.has(key)) {
            byIcon.set(key, []);
        }
        byIcon.get(key).push(item);
    }
    return byIcon;
};

// The GE item a recipe's material or output names: by exact name, or failing that by its image
// when exactly one GE item has that icon ("Net trap (item)" -> Net trap). Matching the image
// against item *names* is deliberately not done: the wiki reuses images ("Lamp oil" is drawn
// with "Swamp tar.png").
const findGeItem = (node, index) => {
    const byName = index.byName.get(String(node.name).toLowerCase());
    if (byName) {
        return byName;
    }

    const byIcon = index.byIcon.get(imageStem(node.image).toLowerCase()) || [];
    if (byIcon.length === 1) {
        return byIcon[0];
    }
    return null;
};

// The name an untradeable node is known by. Usually its name, but the wiki sometimes names a
// variant only in the image: the watered seedling made from "Yew seedling" is output as
// { name: 'Yew seedling', image: 'Yew seedling (w).png' }, and the sapling's recipe asks for
// "Yew seedling (w)". So "<name> (<variant>)" images win.
const untradeableName = (node) => {
    const name = String(node.name).trim();
    const image = imageStem(node.image);
    const isVariantImage = image.toLowerCase().startsWith(`${name.toLowerCase()} (`) && image.endsWith(')');
    if (isVariantImage) {
        return image;
    }
    return name;
};

// A material or output as { id } for a GE item, or { name } for anything else.
const toNode = (node, index) => {
    const quantity = numberOrNull(node.quantity);
    const item = findGeItem(node, index);
    if (item) {
        return { id: item.id, quantity };
    }
    return { name: untradeableName(node), quantity };
};

// --- Recipes ----------------------------------------------------------------------------------

// The saved shape (see the header of the generated file). Empty fields are left out to keep
// the file small; the app fills them back in.
const toRecipe = (raw, index) => {
    const production = raw.production;
    const recipe = {
        page: raw.page,
        output: toNode(production.output, index),
        materials: (production.materials || []).map(material => toNode(material, index)),
    };

    const method = production.output.subtxt || '';
    if (method) {
        recipe.method = method;
    }

    const skills = (production.skills || []).map(skill => ({
        name: skill.name,
        level: numberOrNull(skill.level),
        xp: numberOrNull(skill.experience),
    }));
    if (skills.length) {
        recipe.skills = skills;
    }

    const tools = nameList(production.tools);
    if (tools.length) {
        recipe.tools = tools;
    }

    const facilities = nameList(production.facilities);
    if (facilities.length) {
        recipe.facilities = facilities;
    }

    if (production.members) {
        recipe.members = true;
    }

    const ticks = numberOrNull(production.ticks);
    if (ticks !== null) {
        recipe.ticks = ticks;
    }
    return recipe;
};

// The same recipe is sometimes on two pages (an item and its set, say); keep the first.
const withoutDuplicates = (recipes) => {
    const seen = new Set();
    const unique = [];
    for (const recipe of recipes) {
        const { page, ...rest } = recipe;
        const signature = JSON.stringify(rest);
        if (!seen.has(signature)) {
            seen.add(signature);
            unique.push(recipe);
        }
    }
    return unique;
};

const nodeKey = (node) => {
    if (node.id !== undefined) {
        return `#${node.id}`;
    }
    return node.name.toLowerCase();
};

const touchesGeItem = (recipe) => {
    const nodes = [recipe.output, ...recipe.materials];
    return nodes.some(node => node.id !== undefined);
};

// The recipes that involve a GE item, plus the recipes making the untradeable materials they
// need (and the materials those need, and so on), so a chain like seed -> seedling -> watered
// seedling -> sapling stays complete. Recipes wholly among untradeables are dropped.
const relevantRecipes = (recipes) => {
    const makersByOutput = new Map();
    for (const recipe of recipes) {
        const key = nodeKey(recipe.output);
        if (!makersByOutput.has(key)) {
            makersByOutput.set(key, []);
        }
        makersByOutput.get(key).push(recipe);
    }

    const kept = new Set(recipes.filter(touchesGeItem));
    const pending = [...kept];
    while (pending.length) {
        const recipe = pending.pop();
        for (const material of recipe.materials) {
            if (material.id !== undefined) {
                continue;
            }
            for (const maker of makersByOutput.get(nodeKey(material)) || []) {
                if (!kept.has(maker)) {
                    kept.add(maker);
                    pending.push(maker);
                }
            }
        }
    }
    return recipes.filter(recipe => kept.has(recipe));
};

// --- Output -----------------------------------------------------------------------------------

const renderDataFile = (recipes) => {
    const lines = recipes.map(recipe => `        ${JSON.stringify(recipe)},`);
    return `// Built-in recipes, generated from the OSRS wiki's recipe data by tools/build-item-recipes.mjs
// (fetch it first with tools/fetch-recipe-data.mjs). Don't edit by hand. The app reads it through
// js/formula/itemGraph.js.
//   recipes: [{ page, output, materials, method?, skills?, tools?, facilities?, members?, ticks? }]
//     output / materials: { id, quantity } for a GE item, { name, quantity } for anything else
//                         (coins, untradeable intermediates); quantity is null when it varies
//     method:     which way of making it this is, when there are several ("Double ammo mould")
//     skills:     [{ name, level, xp }]; xp is null when it isn't a fixed number
//     tools / facilities: names (not consumed)
//     ticks:      game ticks per action, when fixed
// It's a script rather than JSON so the app also works when index.html is opened as a file.
const BUILTIN_ITEM_RECIPE_DATA = {
    recipes: [
${lines.join('\n')}
    ],
};
`;
};

const main = async () => {
    const items = await readJson(join(rawDir, 'items.json'));
    const rawRecipes = await readJson(join(rawDir, 'recipes.json'));
    const index = {
        byName: new Map(items.map(item => [item.name.toLowerCase(), item])),
        byIcon: itemsByIcon(items),
    };

    const allRecipes = withoutDuplicates(rawRecipes.map(raw => toRecipe(raw, index)));
    const recipes = relevantRecipes(allRecipes);
    await writeFile(outputFile, renderDataFile(recipes));

    const geOutputs = new Set(recipes.filter(recipe => recipe.output.id !== undefined).map(recipe => recipe.output.id));
    console.log(`recipes: ${recipes.length} kept of ${allRecipes.length} (${rawRecipes.length} before removing duplicates)`);
    console.log(`GE items with a recipe: ${geOutputs.size} / ${items.length}`);
    console.log(`wrote ${outputFile}`);
};

main().catch(error => {
    console.error(error);
    process.exit(1);
});
