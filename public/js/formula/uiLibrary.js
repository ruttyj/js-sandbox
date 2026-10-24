// The `ui` object user code can call to show information in the UI section beside the editor,
// independent of Vue:
//
//   ui.heading('Tree seeds');
//   ui.text('Margins before tax');
//   ui.items(seeds, { title: 'Seeds', shape: 'portrait' });
//   ui.table(seeds, { title: 'Margins', sortBy: 'Margin', sortDir: 'desc', columns: [
//       { label: 'Item', type: 'item', value: s => s },
//       { label: 'Margin', type: 'signedPrice', value: s => s.spread, total: 'sum' },
//   ] });
//   ui.stats({ Profit, Margin }, { types: { Margin: 'percent' } });
//
// A table's search option adds a search box over its rows:
//   search: true                         every text, item and items column
//   search: ['Set', 'Parts']             those columns (by label or key), of any type
//   search: { columns, text, placeholder }
//       columns: as above (left out: the same as true; [] for none)
//       text: row => string or [strings], more text to search that no column shows (tags)
//       placeholder: the box's hint (left out: "Search Set, Parts")
// Every word typed must appear somewhere in the row's searched text (case-insensitive).
//
// Inputs add a form field and return its current value, so the code can work from what's typed;
// changing a field re-runs the code:
//   const item = ui.input.item('Item', { default: 'Magic logs' });
//   const qty  = ui.input.number('Quantity', { default: 1000, min: 1 });
//   const buy  = ui.input.price('Buy at', { default: item.lowPrice });
//   const step = ui.input.select('Step', [1, 2, 5], { default: 2 });
//   const tax  = ui.input.checkbox('Pay GE tax', { default: true });
// Options (all optional):
//   default        the value until the field is changed (and after its reset)
//   key            the field's identity when two labels are the same (left out: the label)
//   number / price min, max, step (a multiple of it), integer (true for prices),
//                  choices: [numbers] (shown as a dropdown)
//   item           choices: [items, IDs or names] (only these can be picked)
//   number, price, item  validate: value => true | false | 'message'
// A value that breaks a rule isn't returned: the code gets the default and the field shows why.
// A default that breaks its own rules is an error in the code. Typed values last for the session.
//
// Each call adds a panel, in call order. A panel is plain data (numbers, strings and { id, name }
// item refs): column value functions run here, inside the run, so drawing or sorting a panel
// never runs user code again, and the loop guard and error line numbers cover them.
//
// Panel shapes (UiPanel):
//   { kind: 'heading' | 'text', text }
//   { kind: 'items', title, shape: 'square' | 'portrait', items: [ItemRef] }
//   { kind: 'table', title, columns: [UiColumn], rows: [[cell]], totals: [number|null] | null,
//     sort: { column, dir } | null, search: UiSearch | null, truncatedFrom: number | null }
//   { kind: 'stats', title, entries: [{ label, type, value }] }
//   { kind: 'input', input: 'number' | 'price' | 'item' | 'select' | 'checkbox', key, label,
//     value, entered, edited, error, ...per input }
//       value: what the code got (an ItemRef for items); entered: what was typed or picked, even
//       when it broke a rule (null while untouched); edited: whether it was changed from the
//       default; error: the broken rule's message, or null.
//       number / price add min, max, step and choices ([{ label, value }] or null); item adds
//       choices ([ItemRef] or null for any item); select adds choices ([{ label, value }]).
// ItemRef: { id, name }; id is null for items looked up before the item list loaded.
// UiColumn: { label, type, align, decimals }. type is never 'auto' here; see resolveAutoType.
// UiSearch: { placeholder, texts: [string] }, texts holding each row's searched text, lowercase.
// Cells hold a number or null (numeric types), a string (text), an ItemRef or null (item), an
// array of ItemRefs (items), or a boolean.
//
// Uses globals from scripts loaded before it:
//   formula/itemRefs.js    findItem
//
// Sections: limits and types -> checking arguments -> items -> cells -> table search -> tables
// -> other panels -> inputs -> public API.
//
// Everything is private to the UiLibrary closure except the names in its returned object (see
// "Public API" at the bottom), which are also exposed as globals for the other scripts.

const UiLibrary = (() => {

    // --- Limits and types -------------------------------------------------------------------------

    const UI_LIBRARY_FN = 'ui';

    // Caps per run, so a ui call inside a big loop can't flood the page.
    const MAX_PANELS = 50;
    const MAX_TABLE_ROWS = 5000;

    // The types a column or stat can ask for. 'auto' picks one from the values (resolveAutoType);
    // 'rsNumber' is what 'auto' gives numbers: RS shorthand like the Values panel (1.5M).
    const UI_COLUMN_TYPES = ['auto', 'price', 'signedPrice', 'number', 'percent', 'text', 'item', 'items', 'boolean'];
    const NUMERIC_TYPES = new Set(['price', 'signedPrice', 'number', 'percent', 'rsNumber']);
    const TOTAL_KINDS = ['sum', 'avg', 'min', 'max'];
    const ITEM_SHAPES = ['square', 'portrait'];
    const SORT_DIRECTIONS = ['asc', 'desc'];
    // The columns search: true looks in: the ones that hold words rather than numbers.
    const DEFAULT_SEARCH_TYPES = new Set(['text', 'item', 'items']);


    // --- Checking arguments -----------------------------------------------------------------------

    // An error in how the code called ui (not one thrown by the code's own value functions).
    class UiError extends Error {}

    // An error naming the ui method it came from: "ui.table: rows must be an array".
    const uiError = (method, message) => new UiError(`ui.${method}: ${message}`);

    const isPlainObject = (value) => {
        if (value === null || typeof value !== 'object') {
            return false;
        }
        return Object.getPrototypeOf(value) === Object.prototype;
    };

    // The options argument, or {} when it was left out.
    const readOptions = (method, options) => {
        if (options === undefined) {
            return {};
        }
        if (!isPlainObject(options)) {
            throw uiError(method, 'options must be an object like { title: "..." }');
        }
        return options;
    };

    // options.title as text, or '' when there's none.
    const readTitle = (options) => {
        if (options.title === undefined || options.title === null) {
            return '';
        }
        return String(options.title);
    };

    // A value that must be one of allowed, or fallback when it's left out.
    const readChoice = (method, what, value, allowed, fallback) => {
        if (value === undefined) {
            return fallback;
        }
        if (!allowed.includes(value)) {
            throw uiError(method, `${what} must be one of ${allowed.map(a => `'${a}'`).join(', ')}, not ${JSON.stringify(value)}`);
        }
        return value;
    };

    const readType = (method, what, type) => {
        return readChoice(method, `${what} type`, type, UI_COLUMN_TYPES, 'auto');
    };


    // --- Items ------------------------------------------------------------------------------------

    // An item as getOsrsItem and queryOsrsItems return it (see toCodeItem).
    const isCodeItem = (value) => {
        return isPlainObject(value)
            && 'id' in value
            && 'highPrice' in value
            && typeof value.name === 'string';
    };

    // The ItemRef for an item, an item ID or an item name. Throws for an unknown item, except
    // before the item list has loaded (then every lookup is a stand-in with id null, as in
    // getOsrsItem).
    const resolveItem = (ctx, method, value) => {
        if (isCodeItem(value)) {
            return { id: value.id, name: value.name };
        }

        const isLookupArg = typeof value === 'number' || typeof value === 'string';
        if (!isLookupArg) {
            throw uiError(method, `expected an item, item ID or item name, not ${describeValue(value)}`);
        }

        const item = findItem(value, ctx.itemsById, ctx.itemsByName);
        if (item) {
            return { id: item.id, name: item.name };
        }
        if (ctx.itemsByName.size === 0) {
            return { id: null, name: String(value) };
        }
        throw uiError(method, `unknown item ${JSON.stringify(value)}`);
    };

    // A short description of a value for error messages.
    const describeValue = (value) => {
        if (Array.isArray(value)) {
            return 'an array';
        }
        if (value === null) {
            return 'null';
        }
        return typeof value === 'object' ? 'an object' : JSON.stringify(value);
    };


    // --- Cells ------------------------------------------------------------------------------------

    // A non-empty array holding only items (null entries allowed), e.g. a query's list().
    const isCodeItemList = (value) => {
        if (!Array.isArray(value)) {
            return false;
        }
        const entries = value.filter(entry => entry !== null && entry !== undefined);
        return entries.length > 0 && entries.every(isCodeItem);
    };

    // The type 'auto' becomes for a set of values: 'item' when they're all items, 'items' when
    // they're all lists of items, 'rsNumber' when they're all numbers, 'boolean' when they're all
    // booleans, otherwise 'text'. Empty values (null / undefined / []) don't count.
    const resolveAutoType = (values) => {
        const kinds = new Set();
        for (const value of values) {
            const isEmptyList = Array.isArray(value) && value.length === 0;
            if (value === null || value === undefined || isEmptyList) {
                continue;
            }
            if (isCodeItem(value)) {
                kinds.add('item');
            } else if (isCodeItemList(value)) {
                kinds.add('items');
            } else if (typeof value === 'number') {
                kinds.add('rsNumber');
            } else if (typeof value === 'boolean') {
                kinds.add('boolean');
            } else {
                kinds.add('text');
            }
        }

        if (kinds.size === 1) {
            return [...kinds][0];
        }
        return 'text';
    };

    // Text for any value: objects and arrays as JSON.
    const valueToText = (value) => {
        if (value === null || value === undefined) {
            return '';
        }
        if (typeof value === 'object') {
            try {
                return JSON.stringify(value);
            } catch (e) {
                return String(value);
            }
        }
        return String(value);
    };

    // An 'items' cell: the ItemRefs for a list of items, IDs or names. Empty entries are skipped;
    // a single item (not in a list) counts as a list of one, and no value as an empty list.
    const toItemListCell = (ctx, method, value) => {
        if (value === null || value === undefined) {
            return [];
        }

        const list = Array.isArray(value) ? value : [value];
        const refs = [];
        for (const entry of list) {
            if (entry !== null && entry !== undefined) {
                refs.push(resolveItem(ctx, method, entry));
            }
        }
        return refs;
    };

    // A value as a cell of the given (resolved) type; see the cell shapes at the top.
    const toCell = (ctx, method, type, value) => {
        if (NUMERIC_TYPES.has(type)) {
            const isNumber = typeof value === 'number' && Number.isFinite(value);
            return isNumber ? value : null;
        }
        if (type === 'item') {
            if (value === null || value === undefined) {
                return null;
            }
            return resolveItem(ctx, method, value);
        }
        if (type === 'items') {
            return toItemListCell(ctx, method, value);
        }
        if (type === 'boolean') {
            return Boolean(value);
        }
        return valueToText(value);
    };


    // --- Table search -----------------------------------------------------------------------------

    // The index of the column a name refers to (by label first, then by key), or throws.
    // option: which option named it, for the error ("sortBy", "search").
    const findColumnIndex = (columns, name, option) => {
        let index = columns.findIndex(column => column.label === String(name));
        if (index === -1) {
            index = columns.findIndex(column => column.key !== null && String(column.key) === String(name));
        }
        if (index === -1) {
            throw uiError('table', `${option} ${JSON.stringify(name)} doesn't match a column label or key`);
        }
        return index;
    };

    // options.search in one shape: { columns: [name] | null, text: function | null, placeholder:
    // string | null }, or null for no search. columns null means the default columns.
    const readSearchOptions = (search) => {
        if (search === undefined || search === null || search === false) {
            return null;
        }
        if (search === true) {
            return { columns: null, text: null, placeholder: null };
        }
        if (Array.isArray(search)) {
            return { columns: search, text: null, placeholder: null };
        }
        if (!isPlainObject(search)) {
            throw uiError('table', 'search must be true, a list of columns, or an object like { columns, text, placeholder }');
        }

        if (search.columns !== undefined && !Array.isArray(search.columns)) {
            throw uiError('table', "search columns must be a list like ['Item', 'Notes']");
        }
        if (search.text !== undefined && typeof search.text !== 'function') {
            throw uiError('table', 'search text must be a function like row => row.notes');
        }

        let placeholder = null;
        if (search.placeholder !== undefined) {
            placeholder = String(search.placeholder);
        }
        return {
            columns: search.columns ?? null,
            text: search.text ?? null,
            placeholder,
        };
    };

    // The indexes of the columns a search looks in.
    const searchColumnIndexes = (columns, types, searchColumns) => {
        if (searchColumns === null) {
            const indexes = [];
            types.forEach((type, index) => {
                if (DEFAULT_SEARCH_TYPES.has(type)) {
                    indexes.push(index);
                }
            });
            return indexes;
        }
        return searchColumns.map(name => findColumnIndex(columns, name, 'search'));
    };

    // A cell as the text a search matches: item names, or the value as text. Booleans and empty
    // cells have none.
    const cellSearchText = (cell) => {
        if (cell === null || cell === undefined || typeof cell === 'boolean') {
            return '';
        }
        if (Array.isArray(cell)) {
            return cell.map(itemRef => itemRef.name).join(' ');
        }
        if (typeof cell === 'object') {
            return cell.name;
        }
        return String(cell);
    };

    // What a search text function returned, as text. A list is joined, so text: row => row.tags works.
    const extraSearchText = (value) => {
        if (Array.isArray(value)) {
            return value.map(valueToText).join(' ');
        }
        return valueToText(value);
    };

    /**
     * The table's UiSearch, or null when options.search doesn't ask for one.
     * @param {Object[]} columns Normalized columns.
     * @param {string[]} types Each column's resolved type.
     * @param {Array[]} cellsByColumn cellsByColumn[column][row].
     * @param {Array} rows The rows the table keeps, for the search text function.
     * @param {*} search options.search.
     */
    const buildSearch = (columns, types, cellsByColumn, rows, search) => {
        const spec = readSearchOptions(search);
        if (!spec) {
            return null;
        }

        const indexes = searchColumnIndexes(columns, types, spec.columns);
        if (!indexes.length && !spec.text) {
            throw uiError('table', "search has no text columns to look in; name them, like search: ['Item']");
        }

        const texts = rows.map((row, rowIndex) => {
            const parts = indexes.map(index => cellSearchText(cellsByColumn[index][rowIndex]));
            if (spec.text) {
                parts.push(extraSearchText(spec.text(row, rowIndex)));
            }
            return parts.join(' ').toLowerCase();
        });

        let placeholder = spec.placeholder;
        if (placeholder === null) {
            const labels = indexes.map(index => columns[index].label);
            placeholder = labels.length ? `Search ${labels.join(', ')}` : 'Search';
        }
        return { placeholder, texts };
    };


    // --- Tables -----------------------------------------------------------------------------------

    // The columns a table shows when the code doesn't list any, from its first row: items get
    // Item / Low / High / Spread; objects one column per key; arrays one per position; anything
    // else a single Value column.
    const inferColumns = (firstRow) => {
        if (isCodeItem(firstRow)) {
            return [
                { label: 'Item', type: 'item', value: (row) => row },
                { label: 'Low', type: 'price', key: 'lowPrice' },
                { label: 'High', type: 'price', key: 'highPrice' },
                { label: 'Spread', type: 'price', key: 'spread' },
            ];
        }
        if (Array.isArray(firstRow)) {
            return firstRow.map((_, index) => ({ label: `Column ${index + 1}`, key: index }));
        }
        if (firstRow !== null && typeof firstRow === 'object') {
            return Object.keys(firstRow);
        }
        return [{ label: 'Value', value: (row) => row }];
    };

    // A column spec as the code wrote it -> { label, key, value, type, align, decimals, total }.
    // 'name' is short for { key: 'name' }.
    const normalizeColumn = (spec, index) => {
        const where = `column ${index + 1}`;
        if (typeof spec === 'string' || typeof spec === 'number') {
            return normalizeColumn({ key: spec }, index);
        }
        if (!isPlainObject(spec)) {
            throw uiError('table', `${where} must be a key or an object like { label, type, value }`);
        }

        const hasValueFn = typeof spec.value === 'function';
        const hasKey = spec.key !== undefined && spec.key !== null;
        if (!hasValueFn && !hasKey) {
            throw uiError('table', `${where} needs a key or a value function`);
        }

        let label = `Column ${index + 1}`;
        if (spec.label !== undefined) {
            label = String(spec.label);
        } else if (hasKey) {
            label = String(spec.key);
        }

        const decimals = spec.decimals;
        const decimalsOk = decimals === undefined || (Number.isInteger(decimals) && decimals >= 0 && decimals <= 10);
        if (!decimalsOk) {
            throw uiError('table', `${where} decimals must be a whole number from 0 to 10`);
        }

        return {
            label,
            key: hasKey ? spec.key : null,
            value: hasValueFn ? spec.value : null,
            type: readType('table', where, spec.type),
            align: readChoice('table', `${where} align`, spec.align, ['left', 'center', 'right'], null),
            decimals: decimals ?? null,
            total: readChoice('table', `${where} total`, spec.total, TOTAL_KINDS, null),
        };
    };

    // One column's raw value for a row.
    const readColumnValue = (column, row, rowIndex) => {
        if (column.value) {
            return column.value(row, rowIndex);
        }
        if (row === null || row === undefined) {
            return undefined;
        }
        return row[column.key];
    };

    const defaultAlign = (type) => (NUMERIC_TYPES.has(type) ? 'right' : 'left');

    // A column total over its cells, ignoring empty ones; null when there are none.
    const columnTotal = (kind, cells) => {
        const numbers = cells.filter(cell => typeof cell === 'number');
        if (!numbers.length) {
            return null;
        }

        let sum = 0;
        for (const number of numbers) {
            sum += number;
        }

        if (kind === 'sum') {
            return sum;
        }
        if (kind === 'avg') {
            return sum / numbers.length;
        }
        if (kind === 'min') {
            return Math.min(...numbers);
        }
        return Math.max(...numbers);
    };

    const readSort = (columns, options) => {
        if (options.sortBy === undefined) {
            return null;
        }
        return {
            column: findColumnIndex(columns, options.sortBy, 'sortBy'),
            dir: readChoice('table', 'sortDir', options.sortDir, SORT_DIRECTIONS, 'asc'),
        };
    };

    // Each row's raw values, one array per column: rawByColumn[column][row].
    const readRawValues = (columns, rows) => {
        const rawByColumn = columns.map(() => []);
        rows.forEach((row, rowIndex) => {
            columns.forEach((column, columnIndex) => {
                rawByColumn[columnIndex].push(readColumnValue(column, row, rowIndex));
            });
        });
        return rawByColumn;
    };

    const buildTable = (ctx, rows, options) => {
        if (!Array.isArray(rows)) {
            throw uiError('table', `rows must be an array, not ${describeValue(rows)}`);
        }
        if (options.columns !== undefined && !Array.isArray(options.columns)) {
            throw uiError('table', 'columns must be an array');
        }

        const keptRows = rows.slice(0, MAX_TABLE_ROWS);
        const columnSpecs = options.columns || (rows.length ? inferColumns(rows[0]) : []);
        const columns = columnSpecs.map(normalizeColumn);
        const rawByColumn = readRawValues(columns, keptRows);

        const types = columns.map((column, index) => {
            return column.type === 'auto' ? resolveAutoType(rawByColumn[index]) : column.type;
        });
        columns.forEach((column, index) => {
            if (column.total && !NUMERIC_TYPES.has(types[index])) {
                throw uiError('table', `column "${column.label}" can only have a total if it holds numbers`);
            }
        });

        const cellsByColumn = rawByColumn.map((values, index) => {
            return values.map(value => toCell(ctx, 'table', types[index], value));
        });
        const tableRows = keptRows.map((_, rowIndex) => cellsByColumn.map(cells => cells[rowIndex]));
        const hasTotals = columns.some(column => column.total);

        return {
            kind: 'table',
            title: readTitle(options),
            columns: columns.map((column, index) => ({
                label: column.label,
                type: types[index],
                align: column.align || defaultAlign(types[index]),
                decimals: column.decimals,
            })),
            rows: tableRows,
            totals: hasTotals
                ? columns.map((column, index) => (column.total ? columnTotal(column.total, cellsByColumn[index]) : null))
                : null,
            sort: readSort(columns, options),
            search: buildSearch(columns, types, cellsByColumn, keptRows, options.search),
            truncatedFrom: rows.length > MAX_TABLE_ROWS ? rows.length : null,
        };
    };


    // --- Other panels -----------------------------------------------------------------------------

    const buildItemStrip = (ctx, list, options) => {
        if (!Array.isArray(list)) {
            throw uiError('items', `expected an array of items, not ${describeValue(list)}`);
        }

        // Empty entries are skipped, e.g. a query's first() that found nothing.
        const items = [];
        for (const entry of list) {
            if (entry !== null && entry !== undefined) {
                items.push(resolveItem(ctx, 'items', entry));
            }
        }

        return {
            kind: 'items',
            title: readTitle(options),
            shape: readChoice('items', 'shape', options.shape, ITEM_SHAPES, 'square'),
            items,
        };
    };

    // stats({ Profit, Margin }) or stats([{ label, value, type }]) -> [{ label, value, type }].
    const statSpecs = (values, options) => {
        if (Array.isArray(values)) {
            return values.map((entry, index) => {
                if (!isPlainObject(entry)) {
                    throw uiError('stats', `entry ${index + 1} must be an object like { label, value, type }`);
                }
                return { label: valueToText(entry.label), value: entry.value, type: entry.type };
            });
        }
        if (!isPlainObject(values)) {
            throw uiError('stats', 'expected an object like { Profit, Margin } or an array of { label, value, type }');
        }

        const types = options.types === undefined ? {} : options.types;
        if (!isPlainObject(types)) {
            throw uiError('stats', 'types must be an object like { Margin: "percent" }');
        }
        return Object.keys(values).map(label => ({ label, value: values[label], type: types[label] }));
    };

    const buildStats = (ctx, values, options) => {
        const entries = statSpecs(values, options).map(spec => {
            const requested = readType('stats', `"${spec.label}"`, spec.type);
            const type = requested === 'auto' ? resolveAutoType([spec.value]) : requested;
            return { label: spec.label, type, value: toCell(ctx, 'stats', type, spec.value) };
        });
        return { kind: 'stats', title: readTitle(options), entries };
    };


    // --- Inputs -----------------------------------------------------------------------------------
    // ui.input.* adds a field and returns its value: what the user entered when it keeps the field's
    // rules, otherwise the default. Entered values live in ctx.inputs (see useUiInputs.js); reading
    // them here, inside the run, is what makes changing one re-run the code. Rules are checked here
    // too, so a validate function runs inside the run like the code's other functions.

    // ctx.inputs for a run that has none: every field reads its default.
    const NO_INPUTS = Object.freeze({ has: () => false, get: () => undefined });

    // The field's label, and its key in ctx.inputs: options.key, else the label. A key can only be
    // used once per run, or two fields would share one value.
    const readInputKey = (method, label, options, usedKeys) => {
        const isLabel = typeof label === 'string' || typeof label === 'number';
        if (!isLabel) {
            throw uiError(method, 'the first argument must be the field\'s label, like "Buy price"');
        }

        const labelText = String(label);
        let key = labelText;
        if (options.key !== undefined) {
            key = String(options.key);
        }

        if (usedKeys.has(key)) {
            throw uiError(method, `another input already uses ${JSON.stringify(key)}; give one a different label or a key option`);
        }
        usedKeys.add(key);
        return { label: labelText, key };
    };

    // options.validate, or null when there's none.
    const readValidate = (method, options) => {
        if (options.validate === undefined) {
            return null;
        }
        if (typeof options.validate !== 'function') {
            throw uiError(method, 'validate must be a function like v => v > 0 || "Must be above 0"');
        }
        return options.validate;
    };

    // What a validate function says about a value: null when it passes, otherwise the message.
    // true (or no return) passes, false fails with a general message, a string fails with it.
    const customRuleError = (method, validate, value) => {
        if (!validate) {
            return null;
        }

        const verdict = validate(value);
        if (verdict === true || verdict === undefined) {
            return null;
        }
        if (verdict === false) {
            return 'Not allowed';
        }
        if (typeof verdict === 'string') {
            return verdict;
        }
        throw uiError(method, 'validate must return true, false or a message');
    };

    // A default that breaks the field's own rules is a mistake in the code, not in what was typed.
    const checkDefault = (method, defaultText, error) => {
        if (error) {
            throw uiError(method, `default ${defaultText}: ${error}`);
        }
    };

    /**
     * The value a field returns, and how the panel shows it.
     * @param {Object} inputs ctx.inputs.
     * @param {string} key
     * @param {*} defaultValue
     * @param {function(*): (string|null)} ruleError The entered value's broken rule, or null.
     * @returns {{ value, entered, edited: boolean, error: string|null }} entered: the stored value
     *     (null when untouched); value: entered when it keeps the rules, otherwise the default.
     */
    const resolveInputValue = (inputs, key, defaultValue, ruleError) => {
        if (!inputs.has(key)) {
            return { value: defaultValue, entered: null, edited: false, error: null };
        }

        const entered = inputs.get(key);
        const error = ruleError(entered);
        if (error) {
            return { value: defaultValue, entered, edited: true, error };
        }
        return { value: entered, entered, edited: true, error: null };
    };

    const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

    const ruleNumberText = (value) => value.toLocaleString(undefined, { maximumFractionDigits: 6 });

    // A number option (min, max, step), or null when it's left out.
    const readOptionalNumber = (method, options, name) => {
        const value = options[name];
        if (value === undefined || value === null) {
            return null;
        }
        if (!isFiniteNumber(value)) {
            throw uiError(method, `${name} must be a number`);
        }
        return value;
    };

    const readNumberChoices = (method, choices) => {
        if (choices === undefined || choices === null) {
            return null;
        }

        const isNumberList = Array.isArray(choices) && choices.length > 0 && choices.every(isFiniteNumber);
        if (!isNumberList) {
            throw uiError(method, 'choices must be a list of numbers like [1, 2, 5]');
        }
        return choices;
    };

    // A number field's rules: { min, max, step, integer, choices, validate }, null for each left out.
    // Prices are whole numbers unless integer: false says otherwise.
    const readNumberRules = (method, options) => {
        const min = readOptionalNumber(method, options, 'min');
        const max = readOptionalNumber(method, options, 'max');
        const step = readOptionalNumber(method, options, 'step');

        if (min !== null && max !== null && min > max) {
            throw uiError(method, 'min must not be above max');
        }
        if (step !== null && step <= 0) {
            throw uiError(method, 'step must be above 0');
        }
        if (options.integer !== undefined && typeof options.integer !== 'boolean') {
            throw uiError(method, 'integer must be true or false');
        }

        return {
            min,
            max,
            step,
            integer: options.integer ?? method === 'input.price',
            choices: readNumberChoices(method, options.choices),
            validate: readValidate(method, options),
        };
    };

    // Whether value is a whole multiple of step. Allows for float error: 0.3 is 0.1 * 3.
    const isOnStep = (value, step) => {
        const steps = value / step;
        return Math.abs(steps - Math.round(steps)) < 1e-9;
    };

    // The first rule a number breaks, as a message, or null when it keeps them all.
    const numberRuleError = (method, rules, value) => {
        if (!isFiniteNumber(value)) {
            return 'Not a number';
        }
        if (rules.choices && !rules.choices.includes(value)) {
            return `Must be one of ${rules.choices.map(ruleNumberText).join(', ')}`;
        }
        if (rules.integer && !Number.isInteger(value)) {
            return 'Must be a whole number';
        }
        if (rules.min !== null && value < rules.min) {
            return `Must be at least ${ruleNumberText(rules.min)}`;
        }
        if (rules.max !== null && value > rules.max) {
            return `Must be at most ${ruleNumberText(rules.max)}`;
        }
        if (rules.step !== null && !isOnStep(value, rules.step)) {
            return `Must be a multiple of ${ruleNumberText(rules.step)}`;
        }
        return customRuleError(method, rules.validate, value);
    };

    // The default a number field starts at: options.default, else min, else the first choice, else
    // 0. A price's default is rounded, so one worked out from a price (high * 0.98) still fits.
    const readNumberDefault = (method, options, rules) => {
        let value = options.default;
        if (value === undefined || value === null) {
            value = rules.min ?? (rules.choices ? rules.choices[0] : 0);
        }
        if (!isFiniteNumber(value)) {
            throw uiError(method, `default must be a number, not ${describeValue(value)}`);
        }
        if (method === 'input.price') {
            return Math.round(value);
        }
        return value;
    };

    // ui.input.number / ui.input.price: a number box (a dropdown with choices) that takes RS
    // shorthand like 1.5m.
    const buildNumberInput = (ctx, inputType, field, options) => {
        const method = `input.${inputType}`;
        const rules = readNumberRules(method, options);
        const defaultValue = readNumberDefault(method, options, rules);
        checkDefault(method, ruleNumberText(defaultValue), numberRuleError(method, rules, defaultValue));

        const resolved = resolveInputValue(ctx.inputs, field.key, defaultValue, (entered) => {
            return numberRuleError(method, rules, entered);
        });

        let choices = null;
        if (rules.choices) {
            choices = rules.choices.map(value => ({ label: ruleNumberText(value), value }));
        }

        const panel = {
            kind: 'input',
            input: inputType,
            ...field,
            ...resolved,
            min: rules.min,
            max: rules.max,
            step: rules.step,
            choices,
        };
        return { panel, value: resolved.value };
    };

    // Whether two ItemRefs are the same item. Stand-ins (id null, before the item list loads) only
    // have their name.
    const isSameItem = (a, b) => {
        if (a.id === null || b.id === null) {
            return a.name === b.name;
        }
        return a.id === b.id;
    };

    // options.choices as ItemRefs, or null for any item.
    const readItemChoices = (ctx, method, choices) => {
        if (choices === undefined || choices === null) {
            return null;
        }
        if (!Array.isArray(choices)) {
            throw uiError(method, "choices must be a list of items, IDs or names, like ['Yew logs', 'Magic logs']");
        }

        const refs = toItemListCell(ctx, method, choices);
        if (!refs.length) {
            throw uiError(method, 'choices must list at least one item');
        }
        return refs;
    };

    const readItemDefault = (ctx, method, options, choices) => {
        const hasDefault = options.default !== undefined && options.default !== null;
        if (hasDefault) {
            return resolveItem(ctx, method, options.default);
        }
        if (choices) {
            return choices[0];
        }
        throw uiError(method, 'needs a default item or a list of choices');
    };

    // The code item for an ItemRef, as getOsrsItem gives it (a stand-in is looked up by name).
    const codeItemOf = (ctx, itemRef) => ctx.getOsrsItem(itemRef.id ?? itemRef.name);

    // The first rule an item breaks, as a message, or null when it keeps them all.
    const itemRuleError = (ctx, method, choices, validate, itemRef) => {
        if (choices && !choices.some(choice => isSameItem(choice, itemRef))) {
            return 'Not one of the allowed items';
        }
        return customRuleError(method, validate, codeItemOf(ctx, itemRef));
    };

    // An entered item ID as an ItemRef, or null when it's no longer a known item.
    const enteredItemRef = (ctx, enteredId) => {
        const item = findItem(enteredId, ctx.itemsById, ctx.itemsByName);
        if (!item) {
            return null;
        }
        return { id: item.id, name: item.name };
    };

    // ui.input.item: an item picker. The field stores the chosen item's ID; the code gets the item
    // as getOsrsItem returns it.
    const buildItemInput = (ctx, field, options) => {
        const method = 'input.item';
        const choices = readItemChoices(ctx, method, options.choices);
        const validate = readValidate(method, options);
        const defaultRef = readItemDefault(ctx, method, options, choices);
        checkDefault(method, JSON.stringify(defaultRef.name), itemRuleError(ctx, method, choices, validate, defaultRef));

        let enteredRef = null;
        const resolved = resolveInputValue(ctx.inputs, field.key, defaultRef, (enteredId) => {
            enteredRef = enteredItemRef(ctx, enteredId);
            if (!enteredRef) {
                return 'Unknown item';
            }
            return itemRuleError(ctx, method, choices, validate, enteredRef);
        });

        // resolved.value is the entered ID when it's used; the panel and the code want the item.
        let valueRef = defaultRef;
        if (resolved.edited && !resolved.error) {
            valueRef = enteredRef;
        }

        const panel = {
            kind: 'input',
            input: 'item',
            ...field,
            ...resolved,
            value: valueRef,
            entered: enteredRef,
            choices,
        };
        return { panel, value: codeItemOf(ctx, valueRef) };
    };

    // A select choice as { label, value }: 'Fast' and 2 are their own label.
    const normalizeSelectChoice = (method, choice, index) => {
        if (typeof choice === 'string' || typeof choice === 'number') {
            return { label: String(choice), value: choice };
        }

        const isLabelled = isPlainObject(choice)
            && (typeof choice.value === 'string' || typeof choice.value === 'number');
        if (!isLabelled) {
            throw uiError(method, `choice ${index + 1} must be text, a number or { label, value }`);
        }

        let label = String(choice.value);
        if (choice.label !== undefined) {
            label = valueToText(choice.label);
        }
        return { label, value: choice.value };
    };

    // ui.input.select: a dropdown of fixed choices, returning the chosen one's value.
    const buildSelectInput = (ctx, field, choiceList, options) => {
        const method = 'input.select';
        if (!Array.isArray(choiceList) || !choiceList.length) {
            throw uiError(method, "choices must be a non-empty list like ['Fast', 'Slow']");
        }

        const choices = choiceList.map((choice, index) => normalizeSelectChoice(method, choice, index));
        const isChoice = (value) => choices.some(choice => choice.value === value);

        let defaultValue = choices[0].value;
        if (options.default !== undefined) {
            defaultValue = options.default;
        }
        if (!isChoice(defaultValue)) {
            throw uiError(method, `default ${JSON.stringify(defaultValue)} isn't one of the choices`);
        }

        const resolved = resolveInputValue(ctx.inputs, field.key, defaultValue, (entered) => {
            return isChoice(entered) ? null : 'No longer one of the choices';
        });

        const panel = { kind: 'input', input: 'select', ...field, ...resolved, choices };
        return { panel, value: resolved.value };
    };

    // ui.input.checkbox: a true / false toggle.
    const buildCheckboxInput = (ctx, field, options) => {
        const method = 'input.checkbox';
        let defaultValue = false;
        if (options.default !== undefined) {
            defaultValue = options.default;
        }
        if (typeof defaultValue !== 'boolean') {
            throw uiError(method, 'default must be true or false');
        }

        const resolved = resolveInputValue(ctx.inputs, field.key, defaultValue, (entered) => {
            return typeof entered === 'boolean' ? null : 'Not true or false';
        });

        const panel = { kind: 'input', input: 'checkbox', ...field, ...resolved };
        return { panel, value: resolved.value };
    };


    // --- Public API -------------------------------------------------------------------------------

    /**
     * Creates the `ui` object for one run, and the panel list its calls fill.
     * @param {Object} context
     * @param {Object<string, Item>} context.itemsById
     * @param {Map<string, Item>} context.itemsByName
     * @param {Object|null} context.inputs The values typed into this code's fields (uiInputsFor),
     *     or null for none.
     * @param {function(string|number): Object} context.getOsrsItem The run's item lookup.
     * @returns {{ api: Object, panels: UiPanel[] }}
     */
    const createUiLibrary = (context) => {
        const ctx = { ...context, inputs: context.inputs || NO_INPUTS };
        const panels = [];
        const usedInputKeys = new Set();

        // Builds a panel and adds it. A UiError is thrown again from here: the engine finds the
        // code's line in the error's stack, and stacks only keep the innermost 10 calls, so an
        // error made deep in a builder can lose the line of the ui call. Errors from the code's
        // own value functions pass through unchanged, since they point at the code already.
        const addPanel = (method, build) => {
            if (panels.length >= MAX_PANELS) {
                throw uiError(method, `a run can show at most ${MAX_PANELS} panels`);
            }

            let panel;
            try {
                panel = build();
            } catch (e) {
                if (e instanceof UiError) {
                    throw new UiError(e.message);
                }
                throw e;
            }
            panels.push(panel);
        };

        // Adds an input's panel and returns the field's value. build(field, options) gives
        // { panel, value }, as the input builders do.
        const addInput = (inputType, label, options, build) => {
            const method = `input.${inputType}`;
            let value;
            addPanel(method, () => {
                const readOpts = readOptions(method, options);
                const field = readInputKey(method, label, readOpts, usedInputKeys);
                const built = build(field, readOpts);
                value = built.value;
                return built.panel;
            });
            return value;
        };

        const input = Object.freeze({
            number: (label, options) => {
                return addInput('number', label, options, (field, opts) => buildNumberInput(ctx, 'number', field, opts));
            },
            price: (label, options) => {
                return addInput('price', label, options, (field, opts) => buildNumberInput(ctx, 'price', field, opts));
            },
            item: (label, options) => {
                return addInput('item', label, options, (field, opts) => buildItemInput(ctx, field, opts));
            },
            select: (label, choices, options) => {
                return addInput('select', label, options, (field, opts) => buildSelectInput(ctx, field, choices, opts));
            },
            checkbox: (label, options) => {
                return addInput('checkbox', label, options, (field, opts) => buildCheckboxInput(ctx, field, opts));
            },
        });

        const api = Object.freeze({
            input,
            heading: (text) => {
                addPanel('heading', () => ({ kind: 'heading', text: valueToText(text) }));
            },
            text: (text) => {
                addPanel('text', () => ({ kind: 'text', text: valueToText(text) }));
            },
            items: (list, options) => {
                addPanel('items', () => buildItemStrip(ctx, list, readOptions('items', options)));
            },
            table: (rows, options) => {
                addPanel('table', () => buildTable(ctx, rows, readOptions('table', options)));
            },
            stats: (values, options) => {
                addPanel('stats', () => buildStats(ctx, values, readOptions('stats', options)));
            },
        });

        return { api, panels };
    };

    return Object.freeze({
        UI_LIBRARY_FN,
        createUiLibrary,
    });
})();

// Classic scripts share one global scope, so the public API is unpacked here for the files that
// follow (the same way vue-globals.js unpacks Vue).
const {
    UI_LIBRARY_FN,
    createUiLibrary,
} = UiLibrary;
