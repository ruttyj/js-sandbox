// Everything a user's app loads at start, in one call. Each record comes as { version, data } so
// the browser knows which version its later saves are based on.
export class StateManager {
    constructor({ scopes, itemTags, variableTags, globals, settings }) {
        this.scopes = scopes;
        this.itemTags = itemTags;
        this.variableTags = variableTags;
        this.globals = globals;
        this.settings = settings;
    }

    async load(userId) {
        const [scopes, itemTags, variableTags, globals, settings] = await Promise.all([
            this.scopes.list(userId),
            this.itemTags.list(userId),
            this.variableTags.list(userId),
            this.globals.get(userId),
            this.settings.get(userId),
        ]);
        return { scopes, itemTags, variableTags, globals, settings };
    }
}
