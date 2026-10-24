// Read-only links to a scope. Anyone with the link can view the scope, signed in or not. A scope's
// code can read its owner's globals and item tags, so the view includes those too: without them
// the scope wouldn't compute the same values for the viewer as for its owner.
import { NotFoundError } from '../errors.js';

// A copy's name: the original's, unless the user already has a scope by that name.
const copyName = (name, takenNames) => {
    if (!takenNames.has(name)) {
        return name;
    }

    let candidate = `${name} (copy)`;
    for (let n = 2; takenNames.has(candidate); n++) {
        candidate = `${name} (copy ${n})`;
    }
    return candidate;
};

export class ShareManager {
    constructor({ scopes, itemTags, variableTags, globals }) {
        this.scopes = scopes;
        this.itemTags = itemTags;
        this.variableTags = variableTags;
        this.globals = globals;
    }

    async findSharedOrThrow(token) {
        const shared = await this.scopes.findShared(token);
        if (!shared) {
            throw new NotFoundError('This link is no longer shared.');
        }
        return shared;
    }

    // { scope, globals, itemTags, variableTags }: plain data, without versions, since the viewer
    // can't save any of it. The share token itself is left out of the scope.
    async view(token) {
        const { userId, record } = await this.findSharedOrThrow(token);
        const [globals, itemTags, variableTags] = await Promise.all([
            this.globals.get(userId),
            this.itemTags.list(userId),
            this.variableTags.list(userId),
        ]);

        const scope = { ...record.data, shareToken: null };
        return {
            scope,
            globals: globals.data,
            itemTags: itemTags.map(tag => tag.data),
            variableTags: variableTags.map(tag => tag.data),
        };
    }

    // Copies the shared scope into userId's scopes, after their others. Only the scope is copied:
    // the owner's globals and item tags it reads aren't, so it may compute differently for the copier.
    // Returns the new scope's record.
    async copy(token, userId) {
        const { record } = await this.findSharedOrThrow(token);

        const existing = await this.scopes.list(userId);
        const takenNames = new Set(existing.map(scope => scope.data.name));
        const id = String(Date.now());
        const data = { ...record.data, id, name: copyName(record.data.name, takenNames), shareToken: null };

        const position = await this.scopes.nextPosition(userId);
        const { version } = await this.scopes.save(userId, id, { version: null, position, data });
        return { version, data };
    }
}
