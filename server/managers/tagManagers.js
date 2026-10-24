// The user's own item tags ({ key, label, parent, items }) and variable tags ({ key, label }).
// See public/js/utils/itemTags.js for how item tags differ from variable tags.
import { CollectionManager } from './CollectionManager.js';
import { parseJsonColumn, toJsonColumn } from './jsonColumns.js';

export class ItemTagManager extends CollectionManager {
    constructor(knex) {
        super(knex, {
            table: 'item_tags',
            keyColumn: 'key',
            toColumns: (data) => ({
                label: data.label,
                parent: data.parent ?? null,
                items: toJsonColumn(data.items),
            }),
            fromRow: (row) => ({
                key: row.key,
                label: row.label,
                parent: row.parent,
                items: parseJsonColumn(row.items, []),
            }),
        });
    }
}

export class VariableTagManager extends CollectionManager {
    constructor(knex) {
        super(knex, {
            table: 'variable_tags',
            keyColumn: 'key',
            toColumns: (data) => ({ label: data.label }),
            fromRow: (row) => ({ key: row.key, label: row.label }),
        });
    }
}
