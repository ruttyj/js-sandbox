// Item icons, cached in localStorage as LZString-compressed data URLs so each icon is fetched
// from the image server once per browser rather than on every page load. Icons are only
// requested once they scroll near the viewport, a few at a time.
// They come from the OSRS wiki because it allows CORS; the GE's obj_big.gif doesn't, so its
// bytes can't be read for caching. The GE image is the fallback when the wiki fetch fails.
const ICON_CACHE_PREFIX = 'osrs-ge-tracker-icon:v1:';
const ICON_FETCH_CONCURRENCY = 6;
const BLANK_ICON_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const getGeIconUrl = (item) => `https://secure.runescape.com/m=itemdb_oldschool/obj_big.gif?id=${item.id}`;
const getWikiIconUrl = (item) => `https://oldschool.runescape.wiki/images/${encodeURIComponent(item.icon.replace(/ /g, '_'))}`;

const iconSrcs = reactive({}); // item id -> src to show (data URL, or the GE URL on failure)
const iconRequested = new Set();
const iconQueue = [];
let iconFetchesActive = 0;
let iconStorageFull = false;

const readCachedIcon = (id) => {
    try {
        const stored = localStorage.getItem(ICON_CACHE_PREFIX + id);
        return stored ? LZString.decompressFromUTF16(stored) : null;
    } catch (e) {
        return null;
    }
};

// Once storage is full, icons are still kept in memory for this session.
const writeCachedIcon = (id, dataUrl) => {
    if (iconStorageFull) return;
    try {
        localStorage.setItem(ICON_CACHE_PREFIX + id, LZString.compressToUTF16(dataUrl));
    } catch (e) {
        iconStorageFull = true;
        console.warn('Icon cache is full; new icons will not be persisted.', e);
    }
};

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
});

const fetchIcon = async (item) => {
    try {
        if (!item.icon) throw new Error('Item has no wiki icon');
        const response = await fetch(getWikiIconUrl(item));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const dataUrl = await blobToDataUrl(await response.blob());
        iconSrcs[item.id] = dataUrl;
        writeCachedIcon(item.id, dataUrl);
    } catch (e) {
        // Not persisted, so the wiki is tried again next session.
        iconSrcs[item.id] = getGeIconUrl(item);
    }
};

const pumpIconQueue = () => {
    while (iconFetchesActive < ICON_FETCH_CONCURRENCY && iconQueue.length) {
        iconFetchesActive++;
        fetchIcon(iconQueue.shift()).finally(() => {
            iconFetchesActive--;
            pumpIconQueue();
        });
    }
};

// Shows the icon from the cache, or queues a fetch. Each id is only requested once per session.
const requestItemIcon = (item) => {
    if (iconRequested.has(item.id)) return;
    iconRequested.add(item.id);
    const cached = readCachedIcon(item.id);
    if (cached) {
        iconSrcs[item.id] = cached;
        return;
    }
    iconQueue.push(item);
    pumpIconQueue();
};

// One observer for every icon on the page; element -> item id it is waiting to show.
const iconElementItems = new WeakMap();
const iconObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const item = iconElementItems.get(entry.target);
        if (item) requestItemIcon(item);
        iconObserver.unobserve(entry.target);
    });
}, { rootMargin: '200px' });

const observeItemIcon = (el, item) => {
    iconElementItems.set(el, item);
    iconObserver.observe(el);
};

const unobserveItemIcon = (el) => {
    iconElementItems.delete(el);
    iconObserver.unobserve(el);
};

const clearIconCache = () => {
    Object.keys(localStorage)
        .filter(key => key.startsWith(ICON_CACHE_PREFIX))
        .forEach(key => localStorage.removeItem(key));
    iconStorageFull = false;
};
