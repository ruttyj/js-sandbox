// Scopes: a block of code plus what the browser derives and decorates it with (see normalizeScope
// in public/js/utils/data.js). A scope can also be shared read-only through an unguessable link.
import crypto from 'node:crypto';
import { CollectionManager } from './CollectionManager.js';
import { parseJsonColumn, toJsonColumn } from './jsonColumns.js';

const scopeToColumns = (data) => ({
    name: data.name,
    code: data.code,
    variables: toJsonColumn(data.variables),
    item_tag_keys: toJsonColumn(data.itemTagKeys),
    item_colors: toJsonColumn(data.itemColors),
    color_seed: data.colorSeed ?? null,
});

// shareToken is the server's to set (see share/unshare); a save from the browser never changes it.
const scopeFromRow = (row) => ({
    id: row.id,
    name: row.name,
    code: row.code,
    variables: parseJsonColumn(row.variables, []),
    itemTagKeys: parseJsonColumn(row.item_tag_keys, []),
    itemColors: parseJsonColumn(row.item_colors, {}),
    colorSeed: row.color_seed ?? undefined,
    shareToken: row.share_token ?? null,
});

const newShareToken = () => crypto.randomBytes(18).toString('base64url');

export class ScopeManager extends CollectionManager {
    constructor(knex) {
        super(knex, { table: 'scopes', keyColumn: 'id', toColumns: scopeToColumns, fromRow: scopeFromRow });
    }

    // The scope's share token, made the first time it's shared. null when the user has no such scope.
    async share(userId, scopeId) {
        const row = await this.rowQuery(this.knex, userId, scopeId).first();
        if (!row) {
            return null;
        }
        if (row.share_token) {
            return row.share_token;
        }

        const token = newShareToken();
        await this.rowQuery(this.knex, userId, scopeId).update({ share_token: token });
        return token;
    }

    // Stops the link working. Returns whether the user has such a scope.
    async unshare(userId, scopeId) {
        const updated = await this.rowQuery(this.knex, userId, scopeId).update({ share_token: null });
        return updated > 0;
    }

    // { userId, record } for the scope shared under token, or null.
    async findShared(token) {
        const row = await this.knex(this.table).where({ share_token: token }).first();
        if (!row) {
            return null;
        }
        return { userId: row.user_id, record: this.toRecord(row) };
    }

    // The position after the user's last scope, for appending one.
    async nextPosition(userId) {
        const result = await this.knex(this.table).where({ user_id: userId }).max('position as maxPosition').first();
        if (result.maxPosition === null) {
            return 0;
        }
        return result.maxPosition + 1;
    }
}
