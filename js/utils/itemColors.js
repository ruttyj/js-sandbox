// Automatic item colors, coordinated by item tags. A scope keeps a palette seed (and the colors
// the user picked by hand); every other item's color is worked out from its tags:
//   - family tags (ones under the "material" root: maple, rune, ranarr, ...) choose the hue, so
//     maple seed, maple sapling and maple logs share a hue
//   - the other tags, kinds (tree-seed, sapling, platebody, ...), choose the shade (lightness
//     and saturation) and nudge the hue, so all seeds share a shade and all saplings another
//   - an item with no family takes its hue from its kinds; one with no tags gets its own hue
// Each tag's shade is random but fixed for a seed. Hues are spread evenly over the families (or,
// for items without one, kinds) a scope uses, in the order they first appear, so two families
// never end up looking alike; a family the scope doesn't use gets a random hue. A new seed gives
// the whole scope a new, still coordinated, palette.

const FAMILY_ROOT_TAG = 'material';

// Tags under this root say where an item comes from, not what it is, so they don't color it.
const SOURCE_ROOT_TAG = 'source';

// A stable number in [0, 1) for a string (32-bit FNV-1a).
const hashUnit = (text) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) / 4294967296;
};

// A random-looking but repeatable value for one seed and one purpose ('hue', 'tone', ...).
const seededUnit = (seed, purpose, key) => hashUnit(`${seed}|${purpose}|${key}`);

const newItemColorSeed = () => Math.floor(Math.random() * 1e9);

// Successive hues this far apart never bunch up, however many there are.
const GOLDEN_ANGLE = 137.508;

// The tags that choose an item's hue: its families, or its kinds when it has none.
const hueTagsOf = (tags, isFamilyTag) => {
    const families = tags.filter(isFamilyTag);
    return families.length ? families : tags;
};

/**
 * Evenly spread hues for the hue-giving tags of a scope's items.
 * @param {Object} options
 * @param {number|string} options.seed The scope's palette seed (it sets the starting hue).
 * @param {string[][]} options.itemTagLists Each item's own tags, in the order the items appear.
 * @param {function(string): boolean} options.isFamilyTag
 * @returns {Map<string, number>} Tag -> hue in degrees, by first appearance.
 */
const allocateTagHues = ({ seed, itemTagLists, isFamilyTag }) => {
    const hues = new Map();
    const startHue = seededUnit(seed, 'start', '') * 360;
    for (const tags of itemTagLists) {
        for (const tag of hueTagsOf(tags, isFamilyTag)) {
            if (!hues.has(tag)) {
                hues.set(tag, (startHue + hues.size * GOLDEN_ANGLE) % 360);
            }
        }
    }
    return hues;
};

// The average of angles in degrees, so 350 and 10 average to 0 rather than 180.
const meanHue = (hues) => {
    let x = 0;
    let y = 0;
    for (const hue of hues) {
        x += Math.cos(hue * Math.PI / 180);
        y += Math.sin(hue * Math.PI / 180);
    }
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

// The hue and shade a group of tags gives. Returns { hue, shift, tone, vivid }: hue in degrees
// (from tagHues, else random for the seed); shift a hue nudge in degrees (-18..18); tone and
// vivid in [0, 1).
const tagColorTraits = (seed, tags, tagHues) => ({
    hue: meanHue(tags.map(tag => tagHues?.get(tag) ?? seededUnit(seed, 'hue', tag) * 360)),
    shift: mean(tags.map(tag => (seededUnit(seed, 'shift', tag) - 0.5) * 36)),
    tone: mean(tags.map(tag => seededUnit(seed, 'tone', tag))),
    vivid: mean(tags.map(tag => seededUnit(seed, 'vivid', tag))),
});

/**
 * An item's automatic color.
 * @param {Object} options
 * @param {number|string} options.seed The scope's palette seed.
 * @param {number|string} options.itemId
 * @param {string[]} options.tags The item's own tags.
 * @param {function(string): boolean} options.isFamilyTag Whether a tag is a family (see top).
 * @param {Map<string, number>} [options.tagHues] Hues allocated for the scope (allocateTagHues).
 * @returns {string} A hex color.
 */
const autoItemColor = ({ seed, itemId, tags, isFamilyTag, tagHues }) => {
    const families = tags.filter(isFamilyTag);
    const kinds = tags.filter(tag => !isFamilyTag(tag));

    let hue = seededUnit(seed, 'item-hue', itemId) * 360;
    let tone = 0.5;
    let vivid = 0.5;

    if (kinds.length) {
        const kindTraits = tagColorTraits(seed, kinds, tagHues);
        hue = kindTraits.hue;
        tone = kindTraits.tone;
        vivid = kindTraits.vivid;
        if (families.length) {
            hue = tagColorTraits(seed, families, tagHues).hue + kindTraits.shift;
        }
    } else if (families.length) {
        hue = tagColorTraits(seed, families, tagHues).hue;
    }

    // A little per-item variation, so items with identical tags can still be told apart.
    const hueJitter = (seededUnit(seed, 'item-jitter', itemId) - 0.5) * 10;
    const lightJitter = (seededUnit(seed, 'item-light', itemId) - 0.5) * 6;

    const finalHue = (hue + hueJitter + 360) % 360;
    const saturation = 60 + vivid * 35;
    const lightness = 40 + tone * 22 + lightJitter;
    return hslToHex(finalHue, saturation, lightness);
};

// Whether a tag is a family: the "material" root is among its ancestors (not the root itself).
const isFamilyTagIn = (defs, key) => {
    const lineage = itemTagLineage(defs, key);
    return lineage.length > 1 && lineage.includes(FAMILY_ROOT_TAG);
};
