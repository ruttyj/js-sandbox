const debounce = (func, delay) => {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), delay);
    };
};

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const RS_SUFFIX_MULTIPLIERS = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

// Either a quoted string (matched only so it can be skipped) or a number with an RS suffix.
const RS_NUMBER_OR_STRING = /(["'`])(?:\\.|(?!\1)[^\\])*\1|\b(\d+(?:\.\d+)?)\s*([kmbt])\b/gi;

// "1.5m" -> 1500000, "10k" -> 10000. Quoted strings (e.g. item names) are left untouched.
const convertRunescapeNumbers = (text) => {
    if (!text) return text;
    return text.toString().replace(RS_NUMBER_OR_STRING, (match, quote, number, suffix) => {
        if (quote) return match;
        return parseFloat(number) * RS_SUFFIX_MULTIPLIERS[suffix.toLowerCase()];
    });
};

// 1234567.891 -> "1,234,567.891". Inserts one comma per pass, from the right of the leading digits.
// Only the integer part gets commas, otherwise long decimals would too ("654.6,600,000").
const numberWithCommas = (x) => {
    const [integerPart, decimalPart] = String(x).split('.');
    let text = integerPart;
    const pattern = /(-?\d+)(\d{3})/;
    while (pattern.test(text)) {
        text = text.replace(pattern, '$1,$2');
    }

    if (decimalPart) {
        return `${text}.${decimalPart}`;
    }
    return text;
};

// 654.6600000000035 -> 654.66. Hides floating-point noise; parseFloat drops trailing zeros.
const roundToTwoDecimals = (num) => parseFloat(num.toFixed(2));

// Largest first, so the biggest unit that fits is used.
const RS_NUMBER_UNITS = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];

// 1500 -> "1.5K", 2500000 -> "2.5M", 1731.23 -> "1.73K", 999 -> "999". Non-numbers are returned as they are.
const formatRSNumber = (num) => {
    if (typeof num !== 'number' || isNaN(num)) {
        return num;
    }

    // Round before picking the unit, so 999.999 becomes "1K" rather than "1,000".
    const rounded = roundToTwoDecimals(num);
    const unit = RS_NUMBER_UNITS.find(([size]) => Math.abs(rounded) >= size);
    if (unit) {
        return `${roundToTwoDecimals(rounded / unit[0])}${unit[1]}`;
    }
    return numberWithCommas(rounded);
};

// Keys holding an identifier: "id", "Id", "ID", or ending in ".id", "_id", "-id", "Id", "ID"
// ("itemId", "item_id", "itemID"). Case matters so words like "paid" or "valid" don't match.
const ID_KEY = /(^|[._-])(id|Id|ID)$|[a-z0-9](Id|ID)$/;

// IDs are labels, not amounts: show 30765, not "30.765K".
const formatObjectEntry = (key, value) => (ID_KEY.test(key) && typeof value === 'number'
    ? String(value)
    : recursiveFormat(value));

// Every number in data (however deeply nested) in RS format.
const recursiveFormat = (data) => {
    if (typeof data === 'number') return formatRSNumber(data);
    if (Array.isArray(data)) return data.map(recursiveFormat);
    if (typeof data === 'object' && data !== null) {
        return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, formatObjectEntry(key, value)]));
    }
    return data;
};

// A variable's value as display text: objects and arrays as indented JSON.
const formatVarValue = (value) => {
    const formatted = recursiveFormat(value);
    return typeof formatted === 'object' ? JSON.stringify(formatted, null, 2) : String(formatted);
};
