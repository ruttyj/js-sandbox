// Item icons, served by this app's server (/icons/<wiki file name>), which downloads each one from
// the OSRS wiki once and keeps it for every user; the browser's HTTP cache does the rest. Icons
// are only requested once they scroll near the viewport. When the server can't provide one (the
// wiki has no such image, or the item has no icon name), the Grand Exchange's own image is shown.
const BLANK_ICON_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const getGeIconUrl = (item) => `https://secure.runescape.com/m=itemdb_oldschool/obj_big.gif?id=${item.id}`;
const getServerIconUrl = (item) => `/icons/${encodeURIComponent(item.icon)}`;

const iconSrcs = reactive({}); // item id -> src to show

// Shows the item's icon. Each id is only set once per page load.
const requestItemIcon = (item) => {
    if (iconSrcs[item.id]) {
        return;
    }
    if (item.icon) {
        iconSrcs[item.id] = getServerIconUrl(item);
    } else {
        iconSrcs[item.id] = getGeIconUrl(item);
    }
};

// The server couldn't provide the icon: fall back to the GE image (once, so a failing GE image
// doesn't loop).
const onItemIconError = (item) => {
    const geUrl = getGeIconUrl(item);
    if (iconSrcs[item.id] !== geUrl) {
        iconSrcs[item.id] = geUrl;
    }
};

// One observer for every icon on the page; element -> item it is waiting to show.
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
