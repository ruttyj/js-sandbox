# Item tagging

Built-in item tags are generated from rules, not hand-assigned per item, so they can be rebuilt
when new items are released:

1. `node tools/fetch-item-data.mjs` downloads every GE item and its wiki categories into
   `data/raw/` (git-ignored).
2. Tag proposals live in `data/tagging/proposals/<domain>.json`: a tag tree for one area of the
   game, and the rules that decide which items get each tag.
3. `node tools/build-item-tags.mjs` merges the proposals into one tag tree (settling conflicts
   with `data/tagging/merge.json`), applies the rules to every item, and writes
   `data/itemTagData.js`, the file the app loads. Add `--report` for every tag's item count.

When new items are released: re-run steps 1 and 3. Items no rule matches are listed nowhere
yet, so check the summary's tagged-item count and extend the proposals' rules if it drops.

## Data available per item (`data/raw/items.json`)

`id`, `name`, `examine`, `members`, `limit` (GE buy limit), `value`, `highalch`, `lowalch`,
`icon`, `volume` (daily trade volume, may be null), `wikiTitle` (null for ~9 items), and
`categories` (the item's wiki page categories, e.g. "Seeds", "Body slot items", "Rune", "Melee
armour"). `data/raw/categories.json` lists every category with how many items carry it.

Note: items sharing a wiki page (e.g. potion doses, "Amulet of glory(4)" -> "Amulet of glory")
share its categories.

## Tag conventions

- **Keys** are lowercase kebab-case nouns, singular: `tree-seed`, `melee-armour`, `rune`,
  `maple`. Labels are human-readable plurals: "Tree seeds".
- **One parent per tag** (`parent: null` for a root). An item tagged `tree-seed` is implicitly
  also `seed` and `farming` if those are its ancestors, so don't list ancestors on the rule.
- **Item tags are for finding items**: think "what would a player search or filter by" -
  category (seed, platebody, potion), material / family (rune, maple, dragon, ranarr), skill
  (farming, smithing), use (teleport, food, prayer-training), source (clue-reward, raid-unique),
  slot (head-slot). An item normally has several tags across these dimensions.
- **Family tags matter**: the app colors items by their tags, so items of one family (maple
  seed, maple sapling, maple logs) should share a family tag (`maple`), and items of one kind
  (all seeds) share a kind tag (`seed`).
- Avoid tags that say nothing useful for finding items: release year, "noteable", "stackable",
  "items dropped by monster".
- Keep a domain to roughly 20-120 tags. Prefer a tag that covers 3+ items.

Shared root tags (use these as parents rather than inventing parallel roots):

| key | meaning |
| --- | --- |
| `equipment` | anything worn or wielded |
| `weapon`, `armour`, `jewellery`, `ammunition` | children of `equipment` |
| `skilling` | root for skill tags: `farming`, `smithing`, `herblore`, `fletching`, `crafting`, `cooking`, `construction`, `runecraft`, `woodcutting`, `mining`, `fishing`, `hunter`, `firemaking`, `prayer`, `magic`, `thieving`, `agility`, `slayer` |
| `consumable` | food, potions, other one-use items |
| `material` | root for families: metal tiers (`bronze` .. `dragon`), wood (`oak`, `maple`, ...), herbs (`ranarr`, ...), gem (`ruby`, ...) |
| `source` | where it comes from: `clue-reward`, `raid-unique`, `boss-drop`, `minigame-reward`, `shop-item` |
| `misc` | anything else |

## Proposal file format

```json
{
  "domain": "farming",
  "notes": "short notes on choices and anything left unresolved",
  "tags": [
    {
      "key": "tree-seed",
      "label": "Tree seeds",
      "parent": "seed",
      "description": "Seeds planted in tree patches (acorn ... magic, redwood)",
      "match": {
        "categoriesAny": ["Tree seeds"],
        "categoriesAll": [],
        "nameRegex": "^(Acorn|Willow seed)$",
        "excludeNameRegex": "\\(p\\)$",
        "ids": [5312]
      }
    }
  ]
}
```

An item gets a tag when it matches **any** of `categoriesAny` / `nameRegex` (case-insensitive JS
regex source) / `ids`, **and** it has every category in `categoriesAll`, **and** its name does not
match `excludeNameRegex`. Omit fields you don't need. A tag with no `match` is a grouping tag
that only gets items through its children.
