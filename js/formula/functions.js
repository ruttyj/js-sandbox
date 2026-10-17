// The library of functions user code can call without declaring them: every Math function in
// upper case (ABS, FLOOR, ROUND, ...) plus SUM, MUL, MIN, MAX, AVERAGE / AVG and
// formatValuesAsStrings. The engine supplies them to the code (see envResolve in engine.js), and
// scopeCode.js treats their names as known.
//
// To add a function, write it here and list it in FORMULA_FUNCTIONS.
//
// Everything is private to the FormulaFunctions closure except the names in its returned object,
// which are also exposed as globals for the other scripts.

const FormulaFunctions = (() => {

    // --- Value helpers ----------------------------------------------------------------------------

    /**
     * Whether SUM and MUL walk into value as an object. Arrays are handled separately (SUM walks
     * them, MUL treats them as 0).
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

    /**
     * Multiplies every value in obj, nested objects included.
     * @example scaleObject({ a: 2, b: { c: 3 } }, 10) // -> { a: 20, b: { c: 30 } }
     * @param {Object} obj
     * @param {number} factor
     * @returns {Object}
     */
    const scaleObject = (obj, factor) => {
        return mapObjectValues(obj, (value) => {
            if (isNonArrayObject(value)) {
                return scaleObject(value, factor);
            }
            return toNumberOrZero(value) * factor;
        });
    };

    /**
     * Multiplies the keys both objects have; keys only one of them has are dropped. Nested objects
     * on both sides are multiplied the same way.
     * @example multiplyMatchingKeys({ a: 2, b: 3, c: 1 }, { a: 4, b: 5 }) // -> { a: 8, b: 15 }
     * @param {Object} a
     * @param {Object} b
     * @returns {Object}
     */
    const multiplyMatchingKeys = (a, b) => {
        const result = {};
        for (const key of Object.keys(a)) {
            if (Object.hasOwn(b, key)) {
                result[key] = multiplyValues(a[key], b[key]);
            }
        }
        return result;
    };

    /**
     * MUL(a, b): numbers multiply; an object times a number scales every value in it; two objects
     * multiply key by key.
     * @param {*} a
     * @param {*} b
     * @returns {number|Object}
     */
    const multiplyValues = (a, b) => {
        const aIsObject = isNonArrayObject(a);
        const bIsObject = isNonArrayObject(b);

        if (aIsObject && bIsObject) {
            return multiplyMatchingKeys(a, b);
        }
        if (aIsObject) {
            return scaleObject(a, toNumberOrZero(b));
        }
        if (bIsObject) {
            return scaleObject(b, toNumberOrZero(a));
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
    };

    /**
     * @param {string} name
     * @returns {boolean} Whether name is one of FORMULA_FUNCTIONS.
     */
    const isFormulaFunction = (name) => {
        return Object.hasOwn(FORMULA_FUNCTIONS, name);
    };


    // --- Public API -------------------------------------------------------------------------------

    return Object.freeze({
        FORMULA_FUNCTIONS,
        isFormulaFunction,
    });
})();

// Classic scripts share one global scope, so the public API is unpacked here for the files that
// follow (the same way vue-globals.js unpacks Vue).
const {
    FORMULA_FUNCTIONS,
    isFormulaFunction,
} = FormulaFunctions;
