// A record a user has exactly one of (their globals, their settings), saved as { version, data }
// with the same version check as CollectionManager. A user who has never saved one reads it as
// version 0 with empty data.
import { ConflictError } from '../errors.js';

export class DocumentManager {
    /**
     * @param {import('knex').Knex} knex
     * @param {object} options
     * @param {string} options.table  One row per user, keyed by user_id.
     * @param {function(object): object} options.toColumns  Data -> column values to write.
     * @param {function(object): object} options.fromRow  A row -> the data.
     * @param {function(): object} options.emptyData  The data of a user who has never saved.
     */
    constructor(knex, { table, toColumns, fromRow, emptyData }) {
        this.knex = knex;
        this.table = table;
        this.toColumns = toColumns;
        this.fromRow = fromRow;
        this.emptyData = emptyData;
    }

    toRecord(row) {
        if (!row) {
            return { version: 0, data: this.emptyData() };
        }
        return { version: row.version, data: this.fromRow(row) };
    }

    async get(userId) {
        const row = await this.knex(this.table).where({ user_id: userId }).first();
        return this.toRecord(row);
    }

    // version: the version the change was based on (0 if never saved). Returns { version }.
    async save(userId, { version, data }) {
        return this.knex.transaction(async (trx) => {
            const existing = await trx(this.table).where({ user_id: userId }).first();
            const currentVersion = existing ? existing.version : 0;
            if (currentVersion !== version) {
                throw new ConflictError(this.toRecord(existing));
            }

            const nextVersion = currentVersion + 1;
            if (existing) {
                await trx(this.table).where({ user_id: userId }).update({
                    ...this.toColumns(data),
                    version: nextVersion,
                    updated_at: trx.fn.now(),
                });
            } else {
                await trx(this.table).insert({ ...this.toColumns(data), user_id: userId, version: nextVersion });
            }
            return { version: nextVersion };
        });
    }
}
