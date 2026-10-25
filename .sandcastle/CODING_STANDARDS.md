
# Coding standards

These are the user's own standards. They value code a person can read top to bottom without
decoding it, over code that is short or clever. When the standards here conflict with the
style of the surrounding code, these win for any code you write or change. Don't reformat code
you aren't otherwise touching unless asked; that bloats diffs and makes reviews harder.

## 1. Blocks, never single-line statements

Every `if`, `else if`, `else`, `for`, `while` and `do` body goes in braces on its own lines,
even when it's one statement. Single-line ifs hide control flow: a reader skimming the left
edge misses the early `return` or `continue`, and adding a second statement later silently
breaks it.

```js
// Avoid
if (!match) continue;
if (item) return item.price; else return 0;

// Prefer
if (!match) {
    continue;
}

if (item) {
    return item.price;
}
return 0;
```

Separate logical steps inside a function with a blank line: guard clauses, then the main work,
then the result.

## 2. Readable over compact

Prefer the version a reader understands on first pass, even if it's longer:

- **Plain loops over clever chains.** A `for...of` loop that pushes or accumulates is usually
  clearer than `reduce`, nested `flatMap`, or a long `.filter().map().reduce()` chain. Short,
  obvious chains (`items.map(i => i.id)`, a single `filter`) are fine.
- **`if` blocks over ternaries that hide logic.** A simple choice between two values on its own
  line is fine (`const field = isHigh ? 'highPrice' : 'lowPrice';`). Nested ternaries, ternaries
  that call functions with side effects, or ternaries used as control flow become `if` blocks.
- **Name intermediate values.** `const isLoopKeyword = word === 'while' || word === 'for';`
  reads better than the condition inlined into an `if`.
- **Split long boolean expressions** one condition per line, with the operator leading.
- **Block-bodied functions for anything with branching.** One-expression arrow functions are
  fine for trivial predicates and accessors; anything with an `if` gets a `{ ... }` body.

## 3. Flat structure, small functions

- Each function does one job that its name states. If you need "and" to describe it, split it.
- Prefer top-level functions over closures nested inside other functions. Deep nesting forces
  the reader to hold several scopes in their head. Pass what a helper needs as arguments (a
  small context object is fine) instead of defining it inside the caller.
- Keep a coordinating function short: it should read like a summary of the steps, each step a
  call to a well-named helper.
- Group a long file into sections with a short header comment
  (`// --- Loop guards ---------------------------`), ordered so helpers come before their users.
- Use descriptive names. Avoid abbreviations (`e`, `m`, `ch` are fine for events, regex matches
  and characters in tight loops; otherwise spell it out).

## 4. Comments that add value

Comment the *why* and the non-obvious, not the *what*:

- Explain intent, constraints and surprises: why an odd ordering matters, why a check exists,
  what an edge case is, what a regex matches (with an example input -> output).
- Document a function's contract when it isn't obvious from the name: parameter shapes,
  return shape, what `null` means.
- Don't restate the code (`// increment i`). If a comment just repeats the line, delete it or
  improve the names instead.
- Keep comments accurate after changes. A stale comment is worse than none.

## 5. No dead or redundant logic

Remove anything that can't run or can't change the result:

- Unreachable branches (code after an always-throwing `try`, conditions already guaranteed).
- Redundant checks or conversions (e.g. `value.trim() !== ''` before `Number(value)` when the
  result is 0 either way; `Number(x)` on something that's already a number).
- Unused variables, parameters, helpers and empty placeholder blocks.

Before deleting, prove it's dead: trace the callers and inputs. Some checks that look
redundant are defensive against real inputs (e.g. symbols reaching a Proxy trap). Keep those
and add a comment saying why they exist. When you remove dead logic, tell the user what it
was and why it couldn't matter.

## 6. Refactors must preserve behaviour

A readability change shouldn't change what the code does. When refactoring:

1. **Safety net first.** If the project isn't under version control, copy the files you'll
   change to a backup (e.g. a scratchpad folder) before editing, and tell the user where it is.
2. **Capture current behaviour.** If there are no tests covering the code, write a small
   harness that runs the original functions on a broad set of inputs (normal cases, edge
   cases, errors) and records the outputs. Run it against the backup to get a baseline.
3. **Refactor, then compare.** Run the same harness on the new code and diff against the
   baseline. Any difference is either a bug you introduced (fix it) or an intended fix (call
   it out explicitly to the user).
4. **Watch for subtle equivalence traps:** float addition order when restructuring sums,
   `obj[key] = ...` vs `Object.fromEntries` for keys like `__proto__`, sort stability, the
   order checks run in when one has side effects or precedence matters, and `||` vs `??`.
5. **Bugs found along the way:** fix them only if they're clearly bugs and small; report
   anything else rather than silently changing behaviour.

## 7. Reporting

When you finish, say what changed and how it was verified (e.g. "identical results on 759
recorded cases"), list any intended behaviour changes and any bugs found but not fixed, and
say what you couldn't verify (e.g. "not tested in a browser").


## ge-tracker project notes


Path: `C:\DATA_ROOT\Dropbox\osrs-ge-tracker\osrs-ge-tracker\cloud\ge-tracker`

## Architecture

- Full-stack since 2026-10-24. An Express server (`server/`, ES modules) serves the browser app
  from `public/` and stores each user's data: routes -> controllers -> managers, Knex + SQLite
  with migrations in `server/db/migrations`, and Google sign-in through Passport. It runs in Docker
  (`docker-compose.yml`; `docker-compose.prod.yml` adds Traefik).
- The browser app has no build step. `public/index.html` loads Vue 3 from a CDN, then each file
  in `public/js/` as a classic `<script>`, in a fixed order (utils -> api -> formula -> components
  -> composables -> app.js). The store (`useTrackerStore`) saves through `js/api/recordSync.js`.
  Callers still edit data in place and then call `saveData()`.
- **All top-level `const`/`let`/`function` names share one global scope across every file.**
  - A new top-level name must be unique project-wide. A duplicate throws `Identifier ... has
    already been declared` and breaks the whole page. Grep for a name before adding it.
  - A file can only use names from files loaded before it (at load time). Inside functions
    called later, any loaded name is fine.
  - Vue helpers (`ref`, `computed`, `watch`, ...) come from `js/vue-globals.js`.
- `js/formula/engine.js` runs user code (`runScopeCode`) via `new Function` + `with` + a Proxy.
  `js/formula/scopeCode.js` parses code into variables. Composables in `js/composables/` wire
  state; `js/app.js` combines them.
- It's a git repository now, so git is the safety net before editing.

## Verifying changes

0. **`npm test`** (vitest) runs the server API tests and `test/browser/sync.test.js`, which runs
   the browser scripts in a `vm` against a real test server.
1. **Load check.** Load every script in `public/index.html` order into one Node `vm` context with
   stubbed `Vue`, `window`, `fetch` and `IntersectionObserver`. This catches duplicate global
   names and load-time errors.
2. **Behaviour harness.** For logic changes, load the pure modules into a `vm` context and record
   outputs for a fixed set of inputs, before and after:
   - modules: `utils/*`, `formula/engine.js`, `formula/scopeCode.js`, and the components and
     composables with Vue stubbed
   - runs to record: `runScopeCode` on many programs, `parseScopeCode`, `migrateLegacyItemRefs`,
     `FormulaInput` highlighting and key handling, store loading and migration
   - Seed `Math.random` and fix `Date.now`, because colors and ids use them.
   - Objects created inside a `vm` context fail `instanceof Map` in the host. Check
     `Object.prototype.toString.call(v)` instead.
3. Say that the browser UI wasn't exercised unless you actually ran it.

## Known issues (as of 2026-10-17)

- Loading legacy data whose variables have comma-string tags (`tags: "x, y"`) crashes.
  `extractLegacyScopes` calls `generateScopeCode` before the tags are normalised. Not fixed yet.
