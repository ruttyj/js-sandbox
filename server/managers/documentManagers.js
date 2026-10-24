// The user's globals (code + the variables derived from it) and their UI settings.
import { DocumentManager } from './DocumentManager.js';
import { parseJsonColumn, toJsonColumn } from './jsonColumns.js';

export class GlobalsManager extends DocumentManager {
    constructor(knex) {
        super(knex, {
            table: 'globals',
            toColumns: (data) => ({ code: data.code, variables: toJsonColumn(data.variables) }),
            fromRow: (row) => ({ code: row.code, variables: parseJsonColumn(row.variables, []) }),
            emptyData: () => ({ code: '', variables: [] }),
        });
    }
}

// editorSettings: the code editors' view toggles; dashboardFilter: the variable tag keys the
// dashboard shows.
export class SettingsManager extends DocumentManager {
    constructor(knex) {
        super(knex, {
            table: 'user_settings',
            toColumns: (data) => ({
                editor_settings: toJsonColumn(data.editorSettings),
                dashboard_filter: toJsonColumn(data.dashboardFilter),
            }),
            fromRow: (row) => ({
                editorSettings: parseJsonColumn(row.editor_settings, {}),
                dashboardFilter: parseJsonColumn(row.dashboard_filter, []),
            }),
            emptyData: () => ({ editorSettings: {}, dashboardFilter: [] }),
        });
    }
}
