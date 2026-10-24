// A user's ordered list of records in one table (scopes, item tags, variable tags). Each record
// is saved on its own, as { version, data }: data is the record in the shape the browser uses,
// and version goes up on every save. A save or delete names the version it was based on and is
// refused with a ConflictError when that's no longer the latest, so a stale tab can't overwrite
// newer changes made in another tab or on another device.
import { ConflictError } from '../errors.js';

export class CollectionManager {
    /**
     * @param {import('knex').Knex} knex
     * @param {object} options
     * @param {string} options.table
     * @param {string} options.keyColumn  The column holding the record's key (unique per user).
     * @param {function(object): object} options.toColumns  Record data -> column values to write.
     * @param {function(object): object} options.fromRow  A row -> the record's data.
     */
    constructor(knex, { table, keyColumn, toColumns, fromRow }) {
        this.knex = knex;
        this.table = table;
        this.keyColumn = keyColumn;
        this.toColumns = toColumns;
        this.fromRow = fromRow;
    }

    rowQuery(db, userId, key) {
        return db(this.table).where({ user_id: userId, [this.keyColumn]: key });
    }

    toRecord(row) {
        return { version: row.version, data: this.fromRow(row) };
    }

    // Every record of the user's, in their saved order.
    async list(userId) {
        const rows = await this.knex(this.table)
            .where({ user_id: userId })
            .orderBy([{ column: 'position' }, { column: this.keyColumn }]);
        return rows.map(row => this.toRecord(row));
    }

    // The record, or null when the user has none with this key.
    async get(userId, key) {
        const row = await this.rowQuery(this.knex, userId, key).first();
        if (!row) {
            return null;
        }
        return this.toRecord(row);
    }

    /**
     * Creates or updates one record. version: the version the change was based on, or null for a
     * record the client has never saved. Returns { version } (the new version).
     */
    async save(userId, key, { version, position, data }) {
        return this.knex.transaction(async (trx) => {
            const existing = await this.rowQuery(trx, userId, key).first();

            if (!existing) {
                // A non-null version means the client saw this record saved before, so it has
                // since been deleted somewhere else.
                if (version !== null) {
                    throw new ConflictError(null);
                }
                await trx(this.table).insert({
                    ...this.toColumns(data),
                    user_id: userId,
                    [this.keyColumn]: key,
                    position,
                    version: 1,
                });
                return { version: 1 };
            }

            if (existing.version !== version) {
                throw new ConflictError(this.toRecord(existing));
            }
            const nextVersion = existing.version + 1;
            await this.rowQuery(trx, userId, key).update({
                ...this.toColumns(data),
                position,
                version: nextVersion,
                updated_at: trx.fn.now(),
            });
            return { version: nextVersion };
        });
    }

    // Deletes one record. Deleting one that's already gone succeeds.
    async remove(userId, key, version) {
        await this.knex.transaction(async (trx) => {
            const existing = await this.rowQuery(trx, userId, key).first();
            if (!existing) {
                return;
            }

            if (existing.version !== version) {
                throw new ConflictError(this.toRecord(existing));
            }
            await this.rowQuery(trx, userId, key).delete();
        });
    }

    // Saves the order of the user's records: keys in their new order. Keys the user has no
    // record for are ignored. Ordering doesn't change a record's version: two tabs reordering is
    // harmless, so the last order saved wins.
    async reorder(userId, keys) {
        await this.knex.transaction(async (trx) => {
            for (const [position, key] of keys.entries()) {
                await this.rowQuery(trx, userId, key).update({ position });
            }
        });
    }
}
