// Loads the browser app's scripts (in index.html order, without app.js) into a vm context, with
// Vue's reactivity stubbed and fetch sent to a test server. Each context is one browser tab.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

const scriptPaths = () => {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
    return srcs.filter(src => !src.startsWith('http') && src !== 'js/app.js');
};

// Enough of Vue for the store: refs are plain boxes and watchers never fire, so tests call
// saveData() themselves after each edit, as the app's code does. Computeds recompute on every read
// and count as refs (isRef), as the ui library's live panels and Ref inputs need.
const vueStub = () => ({
    createApp: () => ({ mount: () => {} }),
    ref: (value) => ({ value }),
    reactive: (object) => object,
    computed: (getterOrOptions) => {
        const get = typeof getterOrOptions === 'function' ? getterOrOptions : getterOrOptions.get;
        const set = typeof getterOrOptions === 'function' ? () => {} : getterOrOptions.set;
        return { __v_isRef: true, get value() { return get(); }, set value(next) { set(next); } };
    },
    isRef: (value) => Boolean(value && value.__v_isRef),
    unref: (value) => (value && value.__v_isRef ? value.value : value),
    markRaw: (object) => object,
    watch: () => {},
    onMounted: () => {},
    onBeforeUnmount: () => {},
    nextTick: (callback) => callback?.(),
});

/**
 * @param {string} baseUrl  The test server, e.g. http://127.0.0.1:1234
 * @param {string} cookie  The session cookie to send ('' for a signed-out tab).
 * @param {object} [browser]
 * @param {object} [browser.localStorage]  This tab's localStorage (none by default).
 * @param {object} [browser.LZString]  Preloaded, as if the app had already fetched it from the CDN.
 * @param {string[]} [browser.exportNames]  More of the scripts' top-level names to hand out.
 * @returns {object} The tab's { useTrackerStore, useImportExport, editorSettings, ApiError, ...exportNames }.
 */
export const openTab = (baseUrl, cookie, { localStorage, LZString, exportNames = [] } = {}) => {
    const tabFetch = (url, options = {}) => fetch(baseUrl + url, {
        ...options,
        headers: { ...options.headers, cookie },
    });
    const context = vm.createContext({
        console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, TextDecoder, AbortController, structuredClone, performance,
        Vue: vueStub(),
        IntersectionObserver: class { observe() {} unobserve() {} },
        window: {
            location: { search: '', pathname: '/', origin: baseUrl, reload: () => {} },
            addEventListener: () => {},
            history: { replaceState: () => {} },
            LZString,
        },
        localStorage,
        fetch: tabFetch,
    });

    let source = '';
    for (const src of scriptPaths()) {
        source += fs.readFileSync(path.join(publicDir, src), 'utf8') + '\n;\n';
    }
    // Top-level const/let aren't properties of the context, so the ones tests use are handed out.
    const names = ['useTrackerStore', 'useImportExport', 'editorSettings', 'ApiError', ...exportNames];
    source += `globalThis.exports = { ${names.join(', ')} };`;
    vm.runInContext(source, context, { filename: 'browser-scripts.js' });
    return context.exports;
};
