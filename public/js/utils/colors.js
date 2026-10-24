// Color helpers: hex <-> HSL conversion, blending, random vibrant colors and fixed UI colors.
//
// Everything is private to the Colors closure except the names in its returned object, which are
// also exposed as globals for the other scripts.

const Colors = (() => {

    const hslToHex = (h, s, l) => {
        l /= 100;
        const a = s * Math.min(l, 1 - l) / 100;
        const f = n => {
            const k = (n + h / 30) % 12;
            const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
            return Math.round(255 * color).toString(16).padStart(2, '0');
        };
        return `#${f(0)}${f(8)}${f(4)}`;
    };

    const hexToHsl = (hex) => {
        const n = parseInt(hex.slice(1, 7), 16);
        const r = ((n >> 16) & 255) / 255;
        const g = ((n >> 8) & 255) / 255;
        const b = (n & 255) / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const l = (max + min) / 2;
        let h = 0;
        let s = 0;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
        }
        return { h, s: s * 100, l: l * 100 };
    };

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    // Mixes hex colors into an HSL color that reads as related to all of them: the saturation-
    // weighted mean hue (the first color's hue when the hues roughly cancel out, e.g. red + cyan),
    // and the mean saturation and lightness.
    const blendColors = (hexes) => {
        const hsls = hexes.map(hexToHsl);
        let x = 0, y = 0, weight = 0;
        hsls.forEach(({ h, s }) => {
            const rad = h * Math.PI / 180;
            x += Math.cos(rad) * s;
            y += Math.sin(rad) * s;
            weight += s;
        });
        const coherent = weight > 0 && Math.hypot(x, y) / weight > 0.3;
        const h = coherent ? (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 : hsls[0].h;
        const mean = (field) => hsls.reduce((sum, c) => sum + c[field], 0) / hsls.length;
        return { h, s: mean('s'), l: mean('l') };
    };

    // Highlight color for keys that have no variable of their own (keys a scope's code only returns).
    const UNDECLARED_COLOR = '#718096';

    const getRandomVibrantColor = () => {
        const h = Math.floor(Math.random() * 360);
        const s = Math.floor(Math.random() * 30) + 70; // 70-100% Saturation
        const l = Math.floor(Math.random() * 20) + 40; // 40-60% Lightness
        return hslToHex(h, s, l);
    };


    // --- Public API -------------------------------------------------------------------------------

    return Object.freeze({
        hslToHex,
        clamp,
        blendColors,
        getRandomVibrantColor,
        UNDECLARED_COLOR,
    });
})();

// Classic scripts share one global scope, so the public API is unpacked here for the files that
// follow (the same way vue-globals.js unpacks Vue).
const {
    hslToHex,
    clamp,
    blendColors,
    getRandomVibrantColor,
    UNDECLARED_COLOR,
} = Colors;
