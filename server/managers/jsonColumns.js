// JSON text columns: what a stored value reads back as when it's missing or unreadable.

export const parseJsonColumn = (text, fallback) => {
    if (typeof text !== 'string' || text === '') {
        return fallback;
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        console.error('Unreadable JSON column; using the default instead.', error);
        return fallback;
    }
};

export const toJsonColumn = (value) => JSON.stringify(value);
