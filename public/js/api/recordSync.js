// Saves the browser's records to the server, sending only what changed. The app edits its data
// in place and then calls saveData() (see useTrackerStore); a sync compares the data with what it
// last saved or loaded and sends the difference.
//
// Every record on the server has a version (see server/managers/CollectionManager.js). A sync
// remembers, per record, the version it last saw and the JSON it last saved. A save the server
// refuses as stale (409: changed in another tab or on another device) stays unsaved and is noted
// as a conflict; adoptServerVersions() then lets the next push overwrite the server's copy.

const encodeRecordKey = (key) => encodeURIComponent(String(key));

const haveSameOrder = (keysA, keysB) => {
    if (keysA.length !== keysB.length) {
        return false;
    }
    return keysA.every((key, index) => key === keysB[index]);
};

// The version a 409 says the server has now; null when the record has been deleted there.
const serverVersionFromConflict = (error) => error.body.current?.version ?? null;

// --- Lists: scopes, item tags, variable tags ------------------------------------------------

/**
 * One ordered list of records, saved one record at a time.
 * @param {object} options
 * @param {string} options.path  e.g. '/api/scopes'
 * @param {function(object): (string|number)} options.keyOf  A record's key (scope id, tag key).
 * @param {function(object): object} options.toData  The part of a record that is saved.
 */
const createCollectionSync = ({ path, keyOf, toData }) => {
    let saved = new Map(); // key -> { version, json } as last saved or loaded
    let savedOrder = [];
    let conflicts = new Map(); // key -> the server's version (null: deleted on the server)

    const snapshot = (items) => items.map(item => ({
        key: String(keyOf(item)),
        json: JSON.stringify(toData(item)),
    }));

    // records: [{ version, data }] as loaded from the server.
    const reset = (records) => {
        saved = new Map();
        for (const record of records) {
            saved.set(String(keyOf(record.data)), { version: record.version, json: JSON.stringify(toData(record.data)) });
        }
        savedOrder = [...saved.keys()];
        conflicts = new Map();
    };

    // Runs one save or delete; a 409 is noted as a conflict rather than thrown, so the rest of
    // the list still saves. Any other error is thrown.
    const sendRecordRequest = async (key, request) => {
        try {
            await request();
        } catch (error) {
            if (!isConflictError(error)) {
                throw error;
            }
            conflicts.set(key, serverVersionFromConflict(error));
        }
    };

    const deleteRemoved = async (currentKeys) => {
        for (const [key, record] of [...saved]) {
            if (currentKeys.has(key)) {
                continue;
            }
            await sendRecordRequest(key, async () => {
                await apiRequest('DELETE', `${path}/${encodeRecordKey(key)}?version=${record.version}`);
                saved.delete(key);
            });
        }
    };

    const saveChanged = async (current) => {
        for (const [position, entry] of current.entries()) {
            const record = saved.get(entry.key);
            if (record && record.json === entry.json) {
                continue;
            }
            await sendRecordRequest(entry.key, async () => {
                const body = { version: record ? record.version : null, position, data: JSON.parse(entry.json) };
                const result = await apiRequest('PUT', `${path}/${encodeRecordKey(entry.key)}`, body);
                saved.set(entry.key, { version: result.version, json: entry.json });
            });
        }
    };

    const saveOrder = async (current) => {
        const order = current.map(entry => entry.key);
        if (haveSameOrder(order, savedOrder)) {
            return;
        }
        await apiRequest('PUT', `${path}/order`, { keys: order });
        savedOrder = order;
    };

    /**
     * Saves every difference between items and what was last saved: deletions, changed and new
     * records, then the order. Returns whether any record conflicted (and is still unsaved).
     * The items are snapshotted first, so edits made while the requests run are left for the
     * next push.
     */
    const push = async (items) => {
        const current = snapshot(items);
        const currentKeys = new Set(current.map(entry => entry.key));
        conflicts = new Map();

        await deleteRemoved(currentKeys);
        await saveChanged(current);
        await saveOrder(current);
        return conflicts.size > 0;
    };

    // Takes the server's version for each conflicted record, so the next push overwrites it with
    // this tab's copy (re-creating it if it was deleted there, deleting it if it was deleted here).
    const adoptServerVersions = () => {
        for (const [key, serverVersion] of conflicts) {
            if (serverVersion === null) {
                saved.delete(key);
            } else {
                saved.set(key, { version: serverVersion, json: null });
            }
        }
        conflicts = new Map();
    };

    return { reset, push, adoptServerVersions };
};

// --- Single records: globals, settings --------------------------------------------------------

/**
 * A record the user has one of.
 * @param {object} options
 * @param {string} options.path  e.g. '/api/globals'
 * @param {function(): object} options.toData  The record's current data.
 */
const createDocumentSync = ({ path, toData }) => {
    let version = 0;
    let savedJson = null;
    let conflictVersion = null;

    // record: { version, data } as loaded from the server.
    const reset = (record) => {
        version = record.version;
        savedJson = JSON.stringify(record.data);
        conflictVersion = null;
    };

    // Returns whether the save conflicted (and is still unsaved).
    const push = async () => {
        const json = JSON.stringify(toData());
        if (json === savedJson) {
            return false;
        }

        try {
            const result = await apiRequest('PUT', path, { version, data: JSON.parse(json) });
            version = result.version;
            savedJson = json;
            return false;
        } catch (error) {
            if (!isConflictError(error)) {
                throw error;
            }
            conflictVersion = serverVersionFromConflict(error) ?? 0;
            return true;
        }
    };

    const adoptServerVersions = () => {
        if (conflictVersion === null) {
            return;
        }
        version = conflictVersion;
        savedJson = null;
        conflictVersion = null;
    };

    return { reset, push, adoptServerVersions };
};
