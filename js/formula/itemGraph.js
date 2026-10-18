// The OSRS item graph: how items are made from each other, from the wiki's recipes
// (data/itemRecipeData.js). User code reads it with two query builders:
//
//   queryOsrsItemRecipes()     every recipe
//     const bows = queryOsrsItemRecipes().producing('Yew longbow').list();
//     const fromLogs = queryOsrsItemRecipes().using('Yew logs').skill('Fletching').list();
//     const sapling = queryOsrsItemRecipes().producing('Yew sapling').expandIntermediates().first();
//       // -> materials: Yew seed x1, Filled plant pot x1 (through the untradeable seedlings)
//
//   queryOsrsItemLinks(type)   links between GE items, as { from, to } pairs
//     const pairs = queryOsrsItemLinks('grows-into').fromTagged('hardwood-seed').list();
//     const sapling = queryOsrsItemLinks('grows-into').from('Yew seed').targets()[0];
//
// Recipe filters: producing(...items), using(...items), producingTagged(...tags),
//                 usingTagged(...tags), skill(...names), members(flag = true), onlyTradeable(),
//                 where(recipe => boolean)
//         option: expandIntermediates() replaces each untradeable material that has exactly
//                 one recipe (a seedling, an unfired pot) with what it's made from
//        results: list(), first(), count()
// Link types:     ingredient-of / made-from     a GE item is (or has) a material of another
//                 grows-into / grown-from       a seed and what it's grown into (Farming)
// Link filters:   from(...items), to(...items), fromTagged(...tags), toTagged(...tags),
//                 where(link => boolean)
//        results: list() -> [{ from, to }], sources(), targets(), count()
//
// Filters given several items or tags match any of them. Items can be given as a name, an ID
// or an item from getOsrsItem; recipe filters also take untradeable names ('Yew seedling').
// Links only join GE items, and follow recipes through untradeable intermediates, so Yew seed
// is an ingredient of Yew sapling.
//
// Everything is private to the ItemGraph closure except the names in its returned object, which
// are also exposed as globals for the other scripts.

/**
 * A recipe as user code sees it.
 * @typedef {Object} CodeRecipe
 * @property {string} page The wiki page it's from.
 * @property {string} method Which way of making it this is, when there are several ("Double
 *     ammo mould"); '' otherwise.
 * @property {CodeRecipeNode} output
 * @property {CodeRecipeNode[]} materials Consumed per action.
 * @property {{ name: string, level: number|null, xp: number|null }[]} skills
 * @property {string[]} tools Needed but not consumed.
 * @property {string[]} facilities Where it's made (Furnace, Anvil, ...).
 * @property {boolean} members
 * @property {number|null} ticks Game ticks per action (of the last step, when expanded).
 * @property {string[]} intermediates Untradeable items made along the way, in the order
 *     they're made; empty unless expandIntermediates() replaced some.
 */

/**
 * A recipe's output or one of its materials.
 * @typedef {Object} CodeRecipeNode
 * @property {number|null} id The GE item ID, or null for anything else (coins, untradeables).
 * @property {string} name
 * @property {number|null} quantity null when it varies.
 * @property {Object|null} item The GE item as getOsrsItem returns it, or null.
 */

const ItemGraph = (() => {

    const RECIPE_QUERY_FN = 'queryOsrsItemRecipes';
    const LINK_QUERY_FN = 'queryOsrsItemLinks';

    const COINS_KEY = 'coins';

    const LINK_TYPES = {
        'ingredient-of': { inverse: false, farming: false },
        'made-from': { inverse: true, farming: false },
        'grows-into': { inverse: false, farming: true },
        'grown-from': { inverse: true, farming: true },
    };

    // A grows-into link starts at an item with this tag (or a tag under it).
    const SEED_TAG = 'seed';


    // --- The recipe index -------------------------------------------------------------------------

    /**
     * A recipe node as data/itemRecipeData.js stores it, with both fields always present.
     * @param {{ id?: number, name?: string, quantity: number|null }} node
     * @returns {{ id: number|null, name: string|null, quantity: number|null }}
     */
    const normalizeNode = (node) => ({
        id: node.id ?? null,
        name: node.name ?? null,
        quantity: node.quantity,
    });

    const normalizeRecipe = (recipe) => ({
        page: recipe.page,
        method: recipe.method || '',
        output: normalizeNode(recipe.output),
        materials: recipe.materials.map(normalizeNode),
        skills: recipe.skills || [],
        tools: recipe.tools || [],
        facilities: recipe.facilities || [],
        members: Boolean(recipe.members),
        ticks: recipe.ticks ?? null,
        intermediates: [],
    });

    // What a node is matched by: '#<id>' for a GE item, its lowercase name otherwise.
    const nodeKey = (node) => {
        if (node.id !== null) {
            return `#${node.id}`;
        }
        return itemNameKey(node.name);
    };

    /**
     * @typedef {Object} RecipeIndex
     * @property {Object[]} recipes Normalized recipes.
     * @property {Map<string, Object[]>} makersByKey The recipes making each node, by nodeKey.
     * @property {Set<string>} untradeableKeys The nodeKey of every untradeable node.
     * @property {Map<Object, Object>} expanded expandRecipe's results, by recipe.
     * @property {Object[]|null} edges buildEdges' result, once built.
     */

    /**
     * @param {{ recipes: Object[] }} data As data/itemRecipeData.js stores it.
     * @returns {RecipeIndex}
     */
    const buildRecipeIndex = (data) => {
        const recipes = data.recipes.map(normalizeRecipe);
        const makersByKey = new Map();
        const untradeableKeys = new Set();

        for (const recipe of recipes) {
            const key = nodeKey(recipe.output);
            if (!makersByKey.has(key)) {
                makersByKey.set(key, []);
            }
            makersByKey.get(key).push(recipe);

            for (const node of [recipe.output, ...recipe.materials]) {
                if (node.id === null) {
                    untradeableKeys.add(nodeKey(node));
                }
            }
        }
        return { recipes, makersByKey, untradeableKeys, expanded: new Map(), edges: null };
    };

    // Built on first use: the data is static, and most code never asks for a recipe.
    let builtinIndex = null;

    const builtinRecipeIndex = () => {
        if (!builtinIndex) {
            builtinIndex = buildRecipeIndex(BUILTIN_ITEM_RECIPE_DATA);
        }
        return builtinIndex;
    };


    // --- Expanding intermediates ------------------------------------------------------------------

    const scaleQuantity = (quantity, scale) => {
        if (quantity === null || scale === null) {
            return null;
        }
        return quantity * scale;
    };

    const addQuantities = (a, b) => {
        if (a === null || b === null) {
            return null;
        }
        return a + b;
    };

    /**
     * The one recipe an untradeable material can be expanded through, or null: GE items stay as
     * they are (they can be bought), as do coins, and so do materials made several ways or in
     * varying amounts, since there's no single answer for what they're made from.
     * @param {RecipeIndex} index
     * @param {Object} material
     * @returns {Object|null}
     */
    const singleUntradeableMaker = (index, material) => {
        const key = nodeKey(material);
        if (material.id !== null || key === COINS_KEY) {
            return null;
        }

        const makers = index.makersByKey.get(key) || [];
        if (makers.length !== 1) {
            return null;
        }

        const maker = makers[0];
        if (material.quantity === null || !maker.output.quantity) {
            return null;
        }
        return maker;
    };

    // Material totals, by nodeKey, so a material reached by two paths is listed once.
    const addMaterial = (expansion, material, scale) => {
        const key = nodeKey(material);
        const quantity = scaleQuantity(material.quantity, scale);
        const existing = expansion.materials.get(key);
        if (existing) {
            existing.quantity = addQuantities(existing.quantity, quantity);
            return;
        }
        expansion.materials.set(key, { ...material, quantity });
    };

    // Each skill once: the highest level any step needs, and the XP of every step together.
    const addSkills = (expansion, skills, scale) => {
        for (const skill of skills) {
            const xp = scaleQuantity(skill.xp, scale);
            const existing = expansion.skills.get(skill.name);
            if (!existing) {
                expansion.skills.set(skill.name, { ...skill, xp });
                continue;
            }

            existing.level = Math.max(existing.level ?? 0, skill.level ?? 0);
            existing.xp = addQuantities(existing.xp, xp);
        }
    };

    const addStep = (expansion, maker, scale) => {
        addSkills(expansion, maker.skills, scale);
        maker.tools.forEach(tool => expansion.tools.add(tool));
        maker.facilities.forEach(facility => expansion.facilities.add(facility));
        if (maker.members) {
            expansion.members = true;
        }
    };

    /**
     * Adds materials to the expansion, replacing the ones that can be expanded by what they're
     * made from. scale: how many of each material's quantity are needed (a material made 4 at a
     * time, needed once, scales its own materials by 1/4).
     * @param {RecipeIndex} index
     * @param {Object} expansion
     * @param {Object[]} materials
     * @param {number} scale
     * @param {Set<string>} visiting The nodes being expanded on this path, so a loop stops.
     */
    const addExpandedMaterials = (index, expansion, materials, scale, visiting) => {
        for (const material of materials) {
            const key = nodeKey(material);
            const maker = singleUntradeableMaker(index, material);
            if (!maker || visiting.has(key)) {
                addMaterial(expansion, material, scale);
                continue;
            }

            const makerScale = scale * material.quantity / maker.output.quantity;
            // Found from the output backwards, so each one is made before the ones already listed.
            expansion.intermediates.unshift(material.name);
            addStep(expansion, maker, makerScale);
            addExpandedMaterials(index, expansion, maker.materials, makerScale, new Set([...visiting, key]));
        }
    };

    /**
     * The recipe with its untradeable materials replaced by what they're made from (see
     * singleUntradeableMaker), all the way down. Tools, facilities and skills of every step are
     * included.
     * @param {RecipeIndex} index
     * @param {Object} recipe
     * @returns {Object} The same shape; the recipe itself when nothing could be expanded.
     */
    const expandRecipe = (index, recipe) => {
        if (index.expanded.has(recipe)) {
            return index.expanded.get(recipe);
        }

        const expansion = {
            materials: new Map(),
            skills: new Map(),
            tools: new Set(recipe.tools),
            facilities: new Set(recipe.facilities),
            members: recipe.members,
            intermediates: [],
        };
        addSkills(expansion, recipe.skills, 1);
        addExpandedMaterials(index, expansion, recipe.materials, 1, new Set([nodeKey(recipe.output)]));

        let expanded = recipe;
        if (expansion.intermediates.length) {
            expanded = {
                ...recipe,
                materials: [...expansion.materials.values()],
                skills: [...expansion.skills.values()],
                tools: [...expansion.tools],
                facilities: [...expansion.facilities],
                members: expansion.members,
                intermediates: expansion.intermediates,
            };
        }
        index.expanded.set(recipe, expanded);
        return expanded;
    };


    // --- Edges between GE items -------------------------------------------------------------------

    /**
     * Every "ingredient-of" edge: a GE item used (directly, or through expanded intermediates) to
     * make another GE item. One edge per pair, however many recipes join them.
     * @param {RecipeIndex} index
     * @returns {{ from: number, to: number, skills: Set<string> }[]} skills: the skills of every
     *     recipe joining the pair.
     */
    const buildEdges = (index) => {
        const edges = new Map();
        for (const recipe of index.recipes) {
            if (recipe.output.id === null) {
                continue;
            }

            const expanded = expandRecipe(index, recipe);
            for (const material of expanded.materials) {
                const isOtherGeItem = material.id !== null && material.id !== recipe.output.id;
                if (!isOtherGeItem) {
                    continue;
                }

                const key = `${material.id}>${recipe.output.id}`;
                if (!edges.has(key)) {
                    edges.set(key, { from: material.id, to: recipe.output.id, skills: new Set() });
                }
                expanded.skills.forEach(skill => edges.get(key).skills.add(skill.name));
            }
        }
        return [...edges.values()];
    };

    const indexEdges = (index) => {
        if (!index.edges) {
            index.edges = buildEdges(index);
        }
        return index.edges;
    };


    // --- What user code gets ----------------------------------------------------------------------

    /**
     * Where the queries read items and tags from.
     * @typedef {Object} ItemGraphContext
     * @property {Object<string, Item>} itemsById
     * @property {Map<string, Item>} itemsByName Items by itemNameKey(name).
     * @property {ItemQuerySource} source For item tags (see itemQuery.js).
     */

    const codeItemById = (context, id) => {
        const item = context.itemsById[id];
        if (!item) {
            return null;
        }
        return toCodeItem(item, context.source.tagsOf(id));
    };

    /**
     * @param {Object} node
     * @param {ItemGraphContext} context
     * @returns {CodeRecipeNode}
     */
    const toCodeNode = (node, context) => {
        if (node.id === null) {
            return { id: null, name: node.name, quantity: node.quantity, item: null };
        }

        // Before the item list has loaded, a GE item is only known by its ID.
        const item = codeItemById(context, node.id);
        const name = item ? item.name : String(node.id);
        return { id: node.id, name, quantity: node.quantity, item };
    };

    /**
     * @param {Object} recipe
     * @param {ItemGraphContext} context
     * @returns {CodeRecipe} A fresh copy, so the code can't change the shared recipes.
     */
    const toCodeRecipe = (recipe, context) => ({
        page: recipe.page,
        method: recipe.method,
        output: toCodeNode(recipe.output, context),
        materials: recipe.materials.map(material => toCodeNode(material, context)),
        skills: recipe.skills.map(skill => ({ ...skill })),
        tools: [...recipe.tools],
        facilities: [...recipe.facilities],
        members: recipe.members,
        ticks: recipe.ticks,
        intermediates: [...recipe.intermediates],
    });


    // --- Query arguments --------------------------------------------------------------------------

    /**
     * The nodeKey an item argument refers to: an item from getOsrsItem, an item ID, a GE item
     * name, or (when allowed) an untradeable name from the recipes.
     * @param {*} arg
     * @param {ItemGraphContext} context
     * @param {RecipeIndex|null} index Where untradeable names are looked up; null for GE items only.
     * @returns {string}
     */
    const itemArgKey = (arg, context, index) => {
        const isCodeItem = arg !== null && typeof arg === 'object' && arg.id !== null && arg.id !== undefined;
        if (isCodeItem) {
            return `#${arg.id}`;
        }

        // Before the item list has loaded, names and IDs can't be checked; they match nothing
        // until it has, rather than being errors.
        const itemsNotLoaded = context.itemsByName.size === 0;

        if (isItemIdArg(arg)) {
            const id = String(arg).trim();
            if (context.itemsById[id] || itemsNotLoaded) {
                return `#${id}`;
            }
            throw new Error(`Unknown item ID ${id}`);
        }

        const item = context.itemsByName.get(itemNameKey(arg));
        if (item) {
            return `#${item.id}`;
        }

        const key = itemNameKey(arg);
        const isUntradeable = index !== null && index.untradeableKeys.has(key);
        if (isUntradeable || itemsNotLoaded) {
            return key;
        }
        throw new Error(`Unknown item "${arg}"`);
    };

    const itemArgKeys = (args, context, index) => {
        return new Set(args.flat().map(arg => itemArgKey(arg, context, index)));
    };

    // Tag keys are lowercase; checking them here turns a typo into a clear error rather than an
    // empty result.
    const checkedTagKeys = (source, keys) => {
        const flat = keys.flat().map(key => String(key).trim().toLowerCase());
        for (const key of flat) {
            if (!source.isTag(key)) {
                throw new Error(`Unknown item tag "${key}"`);
            }
        }
        return flat;
    };

    const hasAnyTag = (source, itemId, tagKeys) => {
        if (itemId === null) {
            return false;
        }
        return tagKeys.some(key => source.hasTag(itemId, key));
    };


    // --- queryOsrsItemRecipes() -------------------------------------------------------------------

    const isTradeableMaterial = (material) => {
        return material.id !== null || nodeKey(material) === COINS_KEY;
    };

    const runRecipeQuery = (context, index, state) => {
        const recipes = [];
        for (const stored of index.recipes) {
            let recipe = stored;
            if (state.expand) {
                recipe = expandRecipe(index, stored);
            }

            if (state.recipeFilters.every(filter => filter(recipe))) {
                recipes.push(toCodeRecipe(recipe, context));
            }
        }
        return recipes.filter(recipe => state.resultFilters.every(filter => filter(recipe)));
    };

    /**
     * A query over every recipe. Each method returns a new query, so a partial one can be reused.
     * @param {ItemGraphContext} context
     * @param {Object} [state] The query so far (internal).
     * @returns {Object} The query builder (see the top of this file).
     */
    const createItemRecipeQuery = (context, state = { recipeFilters: [], resultFilters: [], expand: false }) => {
        const index = builtinRecipeIndex();
        const source = context.source;
        const withRecipeFilter = (filter) => createItemRecipeQuery(context, { ...state, recipeFilters: [...state.recipeFilters, filter] });
        const withResultFilter = (filter) => createItemRecipeQuery(context, { ...state, resultFilters: [...state.resultFilters, filter] });

        return Object.freeze({
            producing: (...items) => {
                const keys = itemArgKeys(items, context, index);
                return withRecipeFilter(recipe => keys.has(nodeKey(recipe.output)));
            },
            using: (...items) => {
                const keys = itemArgKeys(items, context, index);
                return withRecipeFilter(recipe => recipe.materials.some(material => keys.has(nodeKey(material))));
            },
            producingTagged: (...tags) => {
                const tagKeys = checkedTagKeys(source, tags);
                return withRecipeFilter(recipe => hasAnyTag(source, recipe.output.id, tagKeys));
            },
            usingTagged: (...tags) => {
                const tagKeys = checkedTagKeys(source, tags);
                return withRecipeFilter(recipe => recipe.materials.some(material => hasAnyTag(source, material.id, tagKeys)));
            },
            skill: (...names) => {
                const wanted = names.flat().map(name => String(name).trim().toLowerCase());
                return withRecipeFilter(recipe => recipe.skills.some(skill => wanted.includes(skill.name.toLowerCase())));
            },
            members: (flag = true) => withRecipeFilter(recipe => recipe.members === Boolean(flag)),
            onlyTradeable: () => withRecipeFilter(recipe => recipe.output.id !== null && recipe.materials.every(isTradeableMaterial)),
            where: (predicate) => withResultFilter(recipe => Boolean(predicate(recipe))),
            expandIntermediates: () => createItemRecipeQuery(context, { ...state, expand: true }),
            list: () => runRecipeQuery(context, index, state),
            first: () => runRecipeQuery(context, index, state)[0] || null,
            count: () => runRecipeQuery(context, index, state).length,
        });
    };


    // --- queryOsrsItemLinks(type) -----------------------------------------------------------------

    const linkType = (type) => {
        const definition = LINK_TYPES[type];
        if (!definition) {
            throw new Error(`Unknown item link type "${type}" (use ${Object.keys(LINK_TYPES).join(', ')})`);
        }
        return definition;
    };

    // A grows-into edge: made with Farming from a seed.
    const isGrowingEdge = (source, edge) => {
        return edge.skills.has('Farming') && source.hasTag(edge.from, SEED_TAG);
    };

    // The type's edges, turned to point the type's way: { from, to } item IDs.
    const typeEdges = (context, index, definition) => {
        const links = [];
        for (const edge of indexEdges(index)) {
            const isFarmingOnly = definition.farming && !isGrowingEdge(context.source, edge);
            if (isFarmingOnly) {
                continue;
            }

            if (definition.inverse) {
                links.push({ from: edge.to, to: edge.from });
            } else {
                links.push({ from: edge.from, to: edge.to });
            }
        }
        return links;
    };

    const compareLinks = (a, b) => {
        return a.from.name.localeCompare(b.from.name) || a.to.name.localeCompare(b.to.name);
    };

    // Links whose items are both loaded, sorted by name.
    const runLinkQuery = (context, index, state) => {
        const links = [];
        for (const edge of typeEdges(context, index, state.definition)) {
            if (!state.edgeFilters.every(filter => filter(edge))) {
                continue;
            }

            const from = codeItemById(context, edge.from);
            const to = codeItemById(context, edge.to);
            if (from && to) {
                links.push({ from, to });
            }
        }
        return links
            .filter(link => state.resultFilters.every(filter => filter(link)))
            .sort(compareLinks);
    };

    // The distinct items on one side of the links, in the links' order.
    const uniqueItems = (items) => {
        const byId = new Map();
        for (const item of items) {
            if (!byId.has(item.id)) {
                byId.set(item.id, item);
            }
        }
        return [...byId.values()];
    };

    /**
     * A query over the links of one type between GE items. Each method returns a new query.
     * @param {ItemGraphContext} context
     * @param {string} type One of LINK_TYPES.
     * @param {Object} [state] The query so far (internal).
     * @returns {Object} The query builder (see the top of this file).
     */
    const createItemLinkQuery = (context, type, state = null) => {
        const index = builtinRecipeIndex();
        const source = context.source;
        const current = state || { definition: linkType(type), edgeFilters: [], resultFilters: [] };
        const withEdgeFilter = (filter) => createItemLinkQuery(context, type, { ...current, edgeFilters: [...current.edgeFilters, filter] });
        const withResultFilter = (filter) => createItemLinkQuery(context, type, { ...current, resultFilters: [...current.resultFilters, filter] });

        return Object.freeze({
            from: (...items) => {
                const keys = itemArgKeys(items, context, null);
                return withEdgeFilter(edge => keys.has(`#${edge.from}`));
            },
            to: (...items) => {
                const keys = itemArgKeys(items, context, null);
                return withEdgeFilter(edge => keys.has(`#${edge.to}`));
            },
            fromTagged: (...tags) => {
                const tagKeys = checkedTagKeys(source, tags);
                return withEdgeFilter(edge => hasAnyTag(source, edge.from, tagKeys));
            },
            toTagged: (...tags) => {
                const tagKeys = checkedTagKeys(source, tags);
                return withEdgeFilter(edge => hasAnyTag(source, edge.to, tagKeys));
            },
            where: (predicate) => withResultFilter(link => Boolean(predicate(link))),
            list: () => runLinkQuery(context, index, current),
            sources: () => uniqueItems(runLinkQuery(context, index, current).map(link => link.from)),
            targets: () => uniqueItems(runLinkQuery(context, index, current).map(link => link.to)),
            count: () => runLinkQuery(context, index, current).length,
        });
    };


    // --- Public API -------------------------------------------------------------------------------

    return Object.freeze({
        RECIPE_QUERY_FN,
        LINK_QUERY_FN,
        createItemRecipeQuery,
        createItemLinkQuery,
    });
})();

// Classic scripts share one global scope, so the public API is unpacked here for the files that
// follow (the same way vue-globals.js unpacks Vue).
const {
    RECIPE_QUERY_FN,
    LINK_QUERY_FN,
    createItemRecipeQuery,
    createItemLinkQuery,
} = ItemGraph;
