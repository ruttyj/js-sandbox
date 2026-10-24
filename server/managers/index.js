// Every manager, built once and shared by the controllers.
import { GlobalsManager, SettingsManager } from './documentManagers.js';
import { IconManager } from './IconManager.js';
import { ScopeManager } from './ScopeManager.js';
import { ShareManager } from './ShareManager.js';
import { StateManager } from './StateManager.js';
import { ItemTagManager, VariableTagManager } from './tagManagers.js';
import { UserManager } from './UserManager.js';

export const createManagers = ({ knex, config, fetchImpl }) => {
    const records = {
        scopes: new ScopeManager(knex),
        itemTags: new ItemTagManager(knex),
        variableTags: new VariableTagManager(knex),
        globals: new GlobalsManager(knex),
        settings: new SettingsManager(knex),
    };

    return {
        ...records,
        users: new UserManager(knex),
        state: new StateManager(records),
        shares: new ShareManager(records),
        icons: new IconManager({ iconDir: config.iconDir, fetchImpl }),
    };
};
