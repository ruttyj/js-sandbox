// The values typed into the ui.input fields (see uiLibrary.js), kept for this session only: they
// aren't saved with the scope, so a reload starts every field at its default again.
//
// Values are grouped by owner: a scope's id, or UI_INPUTS_GLOBALS for the globals' code. A run
// reads its owner's values while it runs (inside the evaluation's computed), so changing a value
// re-runs exactly the code that reads it.

const UI_INPUTS_GLOBALS = 'globals';

// { [owner]: { [inputKey]: value } }
const uiInputValues = reactive({});

/**
 * The input values of one owner, as the engine and the UI section use them.
 * @param {string|number} owner A scope id, or UI_INPUTS_GLOBALS.
 * @returns {{ has: function(string): boolean, get: function(string): *, set: function(string, *), reset: function(string) }}
 */
const uiInputsFor = (owner) => {
    const ownerKey = String(owner);

    // Read through uiInputValues each time (not a saved reference to the owner's object), so a run
    // that read before the owner had any values still depends on it and re-runs on the first set.
    const values = () => uiInputValues[ownerKey];

    const has = (key) => {
        const ownerValues = values();
        return Boolean(ownerValues) && key in ownerValues;
    };

    const get = (key) => {
        const ownerValues = values();
        if (!ownerValues) {
            return undefined;
        }
        return ownerValues[key];
    };

    const set = (key, value) => {
        if (!uiInputValues[ownerKey]) {
            uiInputValues[ownerKey] = {};
        }
        uiInputValues[ownerKey][key] = value;
    };

    // Back to the field's default.
    const reset = (key) => {
        const ownerValues = values();
        if (ownerValues) {
            delete ownerValues[key];
        }
    };

    return { has, get, set, reset };
};
