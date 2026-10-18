// The library of functions user code can call without declaring them: every Math function in
// upper case (ABS, FLOOR, ROUND, ...) plus SUM, MUL, MIN, MAX, AVERAGE / AVG,
// formatValuesAsStrings, reduce and forEach. The engine supplies them to the code (see envResolve in
// engine.js), and scopeCode.js treats their names as known. FORMULA_FUNCTION_REFERENCE documents
// them for the Scopes tab.
//
// To add a function, write it here, list it in FORMULA_FUNCTIONS, and document it in FUNCTION_DOCS
// (and NAMED_FUNCTION_GROUPS, unless it's one of Math's).
//
// Everything is private to the FormulaFunctions closure except the names in its returned object,
// which are also exposed as globals for the other scripts.

const FormulaFunctions = (() => {

    // --- Value helpers ----------------------------------------------------------------------------

    /**
     * Whether SUM and MUL walk into value as an object. Arrays are handled separately.
     * @param {*} value
     * @returns {boolean}
     */
    const isNonArrayObject = (value) => {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    };

    /**
     * A number, or a numeric string like "12", as a number.
     * @param {*} value
     * @returns {number} The number, or 0 for anything else (NaN, "abc", null, true, ...).
     */
    const toNumberOrZero = (value) => {
        if (typeof value !== 'number' && typeof value !== 'string') {
            return 0;
        }

        const number = Number(value);
        if (Number.isNaN(number)) {
            return 0;
        }
        return number;
    };

    /**
     * A copy of obj with transform applied to each value.
     * @param {Object} obj
     * @param {function(*): *} transform
     * @returns {Object}
     */
    const mapObjectValues = (obj, transform) => {
        const entries = Object.entries(obj).map(([key, value]) => [key, transform(value)]);
        return Object.fromEntries(entries);
    };

    /**
     * Every value, however deeply nested in arrays, as a number.
     * @param {Array} args
     * @returns {number[]}
     */
    const flattenToNumbers = (args) => {
        return args.flat(Infinity).map(Number);
    };


    // --- SUM --------------------------------------------------------------------------------------

    /**
     * Adds up every number in value, walking into arrays and object values. The running total is
     * passed down (rather than summing each branch separately) so floats add up in the order they
     * appear, exactly as a flat list would.
     * @param {*} value A number, numeric string, array or object, nested to any depth.
     * @param {number} [total=0] The total so far.
     * @returns {number}
     */
    const sumDeep = (value, total = 0) => {
        if (Array.isArray(value)) {
            let sum = total;
            for (const item of value) {
                sum = sumDeep(item, sum);
            }
            return sum;
        }

        if (isNonArrayObject(value)) {
            return sumDeep(Object.values(value), total);
        }

        return total + toNumberOrZero(value);
    };


    // --- MUL --------------------------------------------------------------------------------------

    // Inside an array or object, only real numbers are multiplied. Anything else (strings, booleans,
    // null) is kept as it is, so an id cast to a string ({ id: '561', qty: 4 }) survives MUL.

    /**
     * Whether MUL walks into value rather than multiplying it.
     * @param {*} value
     * @returns {boolean}
     */
    const isCollection = (value) => {
        return Array.isArray(value) || isNonArrayObject(value);
    };

    /**
     * Multiplies every number in value, walking into arrays and objects. Other values are kept.
     * @example scaleValue({ id: '561', qty: 4, more: [1, 2] }, 10) // -> { id: '561', qty: 40, more: [10, 20] }
     * @param {*} value
     * @param {number} factor
     * @returns {*}
     */
    const scaleValue = (value, factor) => {
        if (Array.isArray(value)) {
            return value.map(item => scaleValue(item, factor));
        }
        if (isNonArrayObject(value)) {
            return mapObjectValues(value, item => scaleValue(item, factor));
        }
        if (typeof value === 'number') {
            return value * factor;
        }
        return value;
    };

    /**
     * Multiplies two values found under the same key. Collections are multiplied as MUL would;
     * a non-number on either side is kept instead of being multiplied (the left one if both are).
     * @param {*} a
     * @param {*} b
     * @returns {*}
     */
    const multiplyNestedPair = (a, b) => {
        if (isCollection(a) || isCollection(b)) {
            return multiplyValues(a, b);
        }
        if (typeof a !== 'number') {
            return a;
        }
        if (typeof b !== 'number') {
            return b;
        }
        return a * b;
    };

    /**
     * Multiplies the keys both collections have; keys only one of them has are dropped. Two arrays
     * give an array as long as the shorter one; otherwise the result is an object.
     * @example multiplyMatchingKeys({ a: 2, b: 3, c: 1 }, { a: 4, b: 5 }) // -> { a: 8, b: 15 }
     * @example multiplyMatchingKeys([1, 2, 3], [4, 5]) // -> [4, 10]
     * @param {Object|Array} a
     * @param {Object|Array} b
     * @returns {Object|Array}
     */
    const multiplyMatchingKeys = (a, b) => {
        if (Array.isArray(a) && Array.isArray(b)) {
            const length = Math.min(a.length, b.length);
            const result = [];
            for (let i = 0; i < length; i++) {
                result.push(multiplyNestedPair(a[i], b[i]));
            }
            return result;
        }

        const result = {};
        for (const key of Object.keys(a)) {
            if (Object.hasOwn(b, key)) {
                result[key] = multiplyNestedPair(a[key], b[key]);
            }
        }
        return result;
    };

    /**
     * MUL(a, b): numbers (and numeric strings) multiply; a collection times a number scales every
     * number in it; two collections multiply key by key.
     * @param {*} a
     * @param {*} b
     * @returns {number|Object|Array}
     */
    const multiplyValues = (a, b) => {
        const aIsCollection = isCollection(a);
        const bIsCollection = isCollection(b);

        if (aIsCollection && bIsCollection) {
            return multiplyMatchingKeys(a, b);
        }
        if (aIsCollection) {
            return scaleValue(a, toNumberOrZero(b));
        }
        if (bIsCollection) {
            return scaleValue(b, toNumberOrZero(a));
        }
        return toNumberOrZero(a) * toNumberOrZero(b);
    };


    // --- AVERAGE, MIN, MAX ------------------------------------------------------------------------

    /**
     * AVERAGE / AVG: the mean of every value, however deeply nested in arrays.
     * @param {...*} args Numbers, or arrays of them.
     * @returns {number} The mean, or 0 when there are no values.
     */
    const averageValues = (...args) => {
        const values = args.flat(Infinity);
        if (values.length === 0) {
            return 0;
        }

        let total = 0;
        for (const value of values) {
            total += Number(value);
        }
        return total / values.length;
    };

    /**
     * MIN: like Math.min, but also looks inside arrays.
     * @param {...*} args Numbers, or arrays of them.
     * @returns {number}
     */
    const minValue = (...args) => {
        return Math.min(...flattenToNumbers(args));
    };

    /**
     * MAX: like Math.max, but also looks inside arrays.
     * @param {...*} args Numbers, or arrays of them.
     * @returns {number}
     */
    const maxValue = (...args) => {
        return Math.max(...flattenToNumbers(args));
    };


    // --- formatValuesAsStrings --------------------------------------------------------------------

    /**
     * formatValuesAsStrings: the same shape, with every leaf turned into a string.
     * @example convertValuesToString({ a: 1, b: [2, null] }) // -> { a: '1', b: ['2', 'null'] }
     * @param {*} input
     * @returns {string|Array|Object}
     */
    const convertValuesToString = (input) => {
        if (input === null || typeof input !== 'object') {
            return String(input);
        }
        if (Array.isArray(input)) {
            return input.map(convertValuesToString);
        }
        return mapObjectValues(input, convertValuesToString);
    };


    // --- reduce -----------------------------------------------------------------------------------

    /**
     * The accumulator after one callback call. A callback that returns nothing (because it mutated
     * the accumulator in place, or forgot to return) keeps the current one.
     * @param {*} accumulator
     * @param {*} result What the callback returned.
     * @returns {*}
     */
    const nextAccumulator = (accumulator, result) => {
        if (result === undefined) {
            return accumulator;
        }
        return result;
    };

    /**
     * reduce: like Array.prototype.reduce, but also walks an object's own values, and an undefined
     * return keeps the accumulator.
     * @example reduce({ a: 2, b: 3 }, (total, value) => total + value, 0) // -> 5
     * @example reduce([1, 2], (seen, value) => { seen.push(value * 10); }, []) // -> [10, 20]
     * @param {Array|Object} collection Anything else (null, a number, a string, ...) has nothing to
     *   walk, so initialValue comes back unchanged.
     * @param {function(*, *, (number|string), (Array|Object)): *} callback Called with
     *   (accumulator, value, index or key, collection).
     * @param {*} initialValue
     * @returns {*}
     */
    const reduceCollection = (collection, callback, initialValue) => {
        if (collection === null || typeof collection !== 'object') {
            return initialValue;
        }

        let accumulator = initialValue;

        if (Array.isArray(collection)) {
            for (let index = 0; index < collection.length; index++) {
                const result = callback(accumulator, collection[index], index, collection);
                accumulator = nextAccumulator(accumulator, result);
            }
            return accumulator;
        }

        for (const key of Object.keys(collection)) {
            const result = callback(accumulator, collection[key], key, collection);
            accumulator = nextAccumulator(accumulator, result);
        }
        return accumulator;
    };


    // --- forEach ----------------------------------------------------------------------------------

    /**
     * forEach: like Array.prototype.forEach, but also walks an object's own values.
     * @example forEach({ a: 2, b: 3 }, (value, key) => { totals[key] = value * 10; })
     * @param {Array|Object} collection Anything else (null, a number, a string, ...) has nothing to
     *   walk, so callback is never called.
     * @param {function(*, (number|string), (Array|Object)): void} callback Called with
     *   (value, index or key, collection).
     */
    const forEachInCollection = (collection, callback) => {
        if (collection === null || typeof collection !== 'object') {
            return;
        }

        if (Array.isArray(collection)) {
            for (let index = 0; index < collection.length; index++) {
                callback(collection[index], index, collection);
            }
            return;
        }

        for (const key of Object.keys(collection)) {
            callback(collection[key], key, collection);
        }
    };


    // --- The library ------------------------------------------------------------------------------

    /**
     * Every Math function under an upper-case name (ABS, FLOOR, ROUND, ...).
     * @returns {Object<string, Function>}
     */
    const upperCaseMathFunctions = () => {
        const functions = {};
        for (const name of Object.getOwnPropertyNames(Math)) {
            if (typeof Math[name] === 'function') {
                functions[name.toUpperCase()] = Math[name];
            }
        }
        return functions;
    };

    /**
     * The functions the code can call without declaring them, by name.
     * @type {Object<string, Function>}
     */
    const FORMULA_FUNCTIONS = {
        ...upperCaseMathFunctions(),
        // Listed after Math's, so these array-flattening versions replace Math.min / Math.max.
        MIN: minValue,
        MAX: maxValue,
        SUM: (...args) => sumDeep(args),
        MUL: multiplyValues,
        AVERAGE: averageValues,
        AVG: averageValues,
        formatValuesAsStrings: convertValuesToString,
        reduce: reduceCollection,
        forEach: forEachInCollection,
    };

    /**
     * @param {string} name
     * @returns {boolean} Whether name is one of FORMULA_FUNCTIONS.
     */
    const isFormulaFunction = (name) => {
        return Object.hasOwn(FORMULA_FUNCTIONS, name);
    };


    // --- Reference docs ---------------------------------------------------------------------------
    // What the Scopes tab lists under "Built-in functions". Keep an entry here in step with the
    // function's behaviour above.

    /**
     * @typedef {Object} FunctionDoc
     * @property {string} signature How a call looks, e.g. 'POW(base, exponent)'.
     * @property {string} description What it does.
     * @property {Object<string, string>} params Each parameter's name -> what to pass. Empty when
     *   it takes none.
     * @property {string} returns What comes back. Empty when nothing useful does.
     */

    /** @type {Object<string, FunctionDoc>} By the name the code calls it with. */
    const FUNCTION_DOCS = {
        // Totals and averages
        SUM: {
            signature: 'SUM(...values)',
            description: 'Adds up every number, walking into arrays and object values to any depth.',
            params: { values: 'Numbers, numeric strings ("12"), arrays or objects. Anything else counts as 0.' },
            returns: 'The total as a number (0 when there is nothing to add).',
        },
        MUL: {
            signature: 'MUL(a, b)',
            description: 'Multiplies two values. A number times an array or object scales every number in it; two of them multiply key by key, dropping keys only one of them has. Inside an array or object only real numbers are multiplied: strings (e.g. ids cast with String(id)), booleans and null are kept as they are.',
            params: {
                a: 'A number, numeric string, array or object (nested ones are multiplied too).',
                b: 'The same.',
            },
            returns: 'A number, or an array or object with the same keys when either side is one.',
        },
        AVERAGE: {
            signature: 'AVERAGE(...values)',
            description: 'The mean of every value, looking inside arrays to any depth.',
            params: { values: 'Numbers, or arrays of them. A non-numeric value makes the result NaN.' },
            returns: 'The mean as a number (0 when there are no values).',
        },
        AVG: {
            signature: 'AVG(...values)',
            description: 'Short for AVERAGE.',
            params: { values: 'Numbers, or arrays of them.' },
            returns: 'The mean as a number (0 when there are no values).',
        },
        MIN: {
            signature: 'MIN(...values)',
            description: 'The smallest value, looking inside arrays to any depth.',
            params: { values: 'Numbers, or arrays of them. A non-numeric value makes the result NaN.' },
            returns: 'The smallest number (Infinity when there are no values).',
        },
        MAX: {
            signature: 'MAX(...values)',
            description: 'The largest value, looking inside arrays to any depth.',
            params: { values: 'Numbers, or arrays of them. A non-numeric value makes the result NaN.' },
            returns: 'The largest number (-Infinity when there are no values).',
        },

        // Collections
        reduce: {
            signature: 'reduce(collection, callback, initialValue)',
            description: 'Combines every entry of an array or object into one value. A callback that returns nothing keeps the accumulator, so it can change the accumulator in place.',
            params: {
                collection: 'An array or object. Anything else (null, a number, ...) has no entries.',
                callback: '(accumulator, value, indexOrKey, collection) => the new accumulator.',
                initialValue: 'The accumulator to start with.',
            },
            returns: 'The final accumulator (initialValue when there are no entries).',
        },
        forEach: {
            signature: 'forEach(collection, callback)',
            description: 'Calls callback once for every entry of an array or object, in order.',
            params: {
                collection: 'An array or object. Anything else (null, a number, ...) has no entries.',
                callback: '(value, indexOrKey, collection) => anything; what it returns is ignored.',
            },
            returns: '',
        },

        // Formatting
        formatValuesAsStrings: {
            signature: 'formatValuesAsStrings(value)',
            description: 'Turns every value into a string, keeping the shape of arrays and objects.',
            params: { value: 'Anything, nested to any depth.' },
            returns: 'A string, or an array / object of the same shape with string values.',
        },

        // Math
        ABS: {
            signature: 'ABS(x)',
            description: 'The absolute value: x without its sign.',
            params: { x: 'A number.' },
            returns: 'A number, never negative.',
        },
        ACOS: {
            signature: 'ACOS(x)',
            description: 'The arccosine (inverse cosine).',
            params: { x: 'A number from -1 to 1.' },
            returns: 'An angle in radians from 0 to π (NaN outside -1 to 1).',
        },
        ACOSH: {
            signature: 'ACOSH(x)',
            description: 'The inverse hyperbolic cosine.',
            params: { x: 'A number, 1 or more.' },
            returns: 'A number, 0 or more (NaN below 1).',
        },
        ASIN: {
            signature: 'ASIN(x)',
            description: 'The arcsine (inverse sine).',
            params: { x: 'A number from -1 to 1.' },
            returns: 'An angle in radians from -π/2 to π/2 (NaN outside -1 to 1).',
        },
        ASINH: {
            signature: 'ASINH(x)',
            description: 'The inverse hyperbolic sine.',
            params: { x: 'A number.' },
            returns: 'A number.',
        },
        ATAN: {
            signature: 'ATAN(x)',
            description: 'The arctangent (inverse tangent).',
            params: { x: 'A number.' },
            returns: 'An angle in radians from -π/2 to π/2.',
        },
        ATAN2: {
            signature: 'ATAN2(y, x)',
            description: 'The angle from the positive x axis to the point (x, y). Note y comes first.',
            params: { y: 'The point\'s y coordinate.', x: 'The point\'s x coordinate.' },
            returns: 'An angle in radians from -π to π.',
        },
        ATANH: {
            signature: 'ATANH(x)',
            description: 'The inverse hyperbolic tangent.',
            params: { x: 'A number from -1 to 1.' },
            returns: 'A number (±Infinity at ±1, NaN outside -1 to 1).',
        },
        CBRT: {
            signature: 'CBRT(x)',
            description: 'The cube root.',
            params: { x: 'A number (negative numbers work).' },
            returns: 'A number.',
        },
        CEIL: {
            signature: 'CEIL(x)',
            description: 'Rounds up to the next whole number.',
            params: { x: 'A number.' },
            returns: 'The smallest whole number that is x or more, e.g. CEIL(1.2) = 2.',
        },
        CLZ32: {
            signature: 'CLZ32(x)',
            description: 'Counts the leading zero bits of x as a 32-bit unsigned integer.',
            params: { x: 'A number (converted to a 32-bit unsigned integer).' },
            returns: 'A whole number from 0 to 32.',
        },
        COS: {
            signature: 'COS(x)',
            description: 'The cosine.',
            params: { x: 'An angle in radians.' },
            returns: 'A number from -1 to 1.',
        },
        COSH: {
            signature: 'COSH(x)',
            description: 'The hyperbolic cosine.',
            params: { x: 'A number.' },
            returns: 'A number, 1 or more.',
        },
        EXP: {
            signature: 'EXP(x)',
            description: 'e (about 2.718) to the power of x.',
            params: { x: 'The exponent.' },
            returns: 'A positive number.',
        },
        EXPM1: {
            signature: 'EXPM1(x)',
            description: 'e to the power of x, minus 1. More accurate than EXP(x) - 1 when x is close to 0.',
            params: { x: 'The exponent.' },
            returns: 'A number greater than -1.',
        },
        FLOOR: {
            signature: 'FLOOR(x)',
            description: 'Rounds down to the previous whole number.',
            params: { x: 'A number.' },
            returns: 'The largest whole number that is x or less, e.g. FLOOR(1.8) = 1, FLOOR(-1.2) = -2.',
        },
        FROUND: {
            signature: 'FROUND(x)',
            description: 'Rounds to the nearest 32-bit (single precision) float.',
            params: { x: 'A number.' },
            returns: 'A number.',
        },
        HYPOT: {
            signature: 'HYPOT(...values)',
            description: 'The square root of the sum of the squares, e.g. the length of a diagonal.',
            params: { values: 'Numbers.' },
            returns: 'A number, 0 or more, e.g. HYPOT(3, 4) = 5.',
        },
        IMUL: {
            signature: 'IMUL(a, b)',
            description: 'Multiplies as 32-bit integers, wrapping around on overflow like C.',
            params: { a: 'A number (converted to a 32-bit integer).', b: 'The same.' },
            returns: 'A 32-bit integer.',
        },
        LOG: {
            signature: 'LOG(x)',
            description: 'The natural logarithm (base e).',
            params: { x: 'A positive number.' },
            returns: 'A number (-Infinity at 0, NaN below 0).',
        },
        LOG10: {
            signature: 'LOG10(x)',
            description: 'The base-10 logarithm.',
            params: { x: 'A positive number.' },
            returns: 'A number, e.g. LOG10(1000) = 3 (-Infinity at 0, NaN below 0).',
        },
        LOG1P: {
            signature: 'LOG1P(x)',
            description: 'The natural logarithm of 1 + x. More accurate than LOG(1 + x) when x is close to 0.',
            params: { x: 'A number greater than -1.' },
            returns: 'A number (-Infinity at -1, NaN below -1).',
        },
        LOG2: {
            signature: 'LOG2(x)',
            description: 'The base-2 logarithm.',
            params: { x: 'A positive number.' },
            returns: 'A number, e.g. LOG2(8) = 3 (-Infinity at 0, NaN below 0).',
        },
        POW: {
            signature: 'POW(base, exponent)',
            description: 'base to the power of exponent. The same as base ** exponent.',
            params: { base: 'A number.', exponent: 'A number.' },
            returns: 'A number, e.g. POW(2, 10) = 1024.',
        },
        RANDOM: {
            signature: 'RANDOM()',
            description: 'A random number. It changes every time the code runs.',
            params: {},
            returns: 'A number from 0 up to (but not including) 1.',
        },
        ROUND: {
            signature: 'ROUND(x)',
            description: 'Rounds to the nearest whole number. Halves round up, towards +Infinity.',
            params: { x: 'A number.' },
            returns: 'A whole number, e.g. ROUND(2.5) = 3, ROUND(-2.5) = -2.',
        },
        SIGN: {
            signature: 'SIGN(x)',
            description: 'Whether x is positive, negative or zero.',
            params: { x: 'A number.' },
            returns: '1, -1 or 0.',
        },
        SIN: {
            signature: 'SIN(x)',
            description: 'The sine.',
            params: { x: 'An angle in radians.' },
            returns: 'A number from -1 to 1.',
        },
        SINH: {
            signature: 'SINH(x)',
            description: 'The hyperbolic sine.',
            params: { x: 'A number.' },
            returns: 'A number.',
        },
        SQRT: {
            signature: 'SQRT(x)',
            description: 'The square root.',
            params: { x: 'A number, 0 or more.' },
            returns: 'A number, 0 or more (NaN below 0).',
        },
        TAN: {
            signature: 'TAN(x)',
            description: 'The tangent.',
            params: { x: 'An angle in radians.' },
            returns: 'A number.',
        },
        TANH: {
            signature: 'TANH(x)',
            description: 'The hyperbolic tangent.',
            params: { x: 'A number.' },
            returns: 'A number from -1 to 1.',
        },
        TRUNC: {
            signature: 'TRUNC(x)',
            description: 'Drops the fraction, rounding towards 0.',
            params: { x: 'A number.' },
            returns: 'A whole number, e.g. TRUNC(1.8) = 1, TRUNC(-1.8) = -1.',
        },
    };

    /**
     * The reference groups, in the order they're listed. Every function not named here is one of
     * Math's and goes in the Math group.
     */
    const NAMED_FUNCTION_GROUPS = [
        { title: 'Totals and averages', names: ['SUM', 'MUL', 'AVERAGE', 'AVG', 'MIN', 'MAX'] },
        { title: 'Collections', names: ['reduce', 'forEach'] },
        { title: 'Formatting', names: ['formatValuesAsStrings'] },
    ];

    /**
     * The doc for one function, as the reference lists it. A Math function this file has no doc
     * for (one a newer browser added) still gets a short generic entry, so every callable name is
     * listed.
     * @param {string} name
     * @returns {{ name: string, signature: string, description: string, params: { name: string, description: string }[], returns: string }}
     */
    const describeFunction = (name) => {
        const doc = FUNCTION_DOCS[name];
        if (!doc) {
            return {
                name,
                signature: `${name}(...)`,
                description: 'The JavaScript Math function of the same name (ignoring case).',
                params: [],
                returns: '',
            };
        }

        const params = [];
        for (const [paramName, description] of Object.entries(doc.params)) {
            params.push({ name: paramName, description });
        }
        return { name, signature: doc.signature, description: doc.description, params, returns: doc.returns };
    };

    /**
     * Every function in FORMULA_FUNCTIONS, documented and grouped for the Scopes tab.
     * @returns {{ title: string, functions: Object[] }[]} See describeFunction for each function.
     */
    const buildFunctionReference = () => {
        const groups = [];
        const grouped = new Set();
        for (const group of NAMED_FUNCTION_GROUPS) {
            groups.push({ title: group.title, functions: group.names.map(describeFunction) });
            for (const name of group.names) {
                grouped.add(name);
            }
        }

        const mathNames = Object.keys(FORMULA_FUNCTIONS).filter(name => !grouped.has(name)).sort();
        groups.push({ title: 'Math', functions: mathNames.map(describeFunction) });
        return groups;
    };

    const FORMULA_FUNCTION_REFERENCE = buildFunctionReference();


    // --- Public API -------------------------------------------------------------------------------

    return Object.freeze({
        FORMULA_FUNCTIONS,
        FORMULA_FUNCTION_REFERENCE,
        isFormulaFunction,
    });
})();

// Classic scripts share one global scope, so the public API is unpacked here for the files that
// follow (the same way vue-globals.js unpacks Vue).
const {
    FORMULA_FUNCTIONS,
    FORMULA_FUNCTION_REFERENCE,
    isFormulaFunction,
} = FormulaFunctions;
