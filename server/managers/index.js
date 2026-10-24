// Every manager, built once and shared by the controllers.
import { verifyAnthropicKey } from '../ai/anthropicChat.js';
import { verifyGeminiKey } from '../ai/geminiChat.js';
import { createKeyCipher } from '../ai/keyCipher.js';
import { AiConversationManager } from './AiConversationManager.js';
import { AiKeyManager } from './AiKeyManager.js';
import { GlobalsManager, SettingsManager } from './documentManagers.js';
import { IconManager } from './IconManager.js';
import { ScopeManager } from './ScopeManager.js';
import { ShareManager } from './ShareManager.js';
import { StateManager } from './StateManager.js';
import { ItemTagManager, VariableTagManager } from './tagManagers.js';
import { UserManager } from './UserManager.js';

// Checks an API key with the provider it's for.
const checkKeyWithProvider = (provider, apiKey) => {
    if (provider === 'gemini') {
        return verifyGeminiKey(apiKey);
    }
    return verifyAnthropicKey(apiKey);
};

// verifyApiKey: (provider, apiKey) checks a user's key; tests replace it so no request is made.
export const createManagers = ({ knex, config, fetchImpl, verifyApiKey = checkKeyWithProvider }) => {
    let keyCipher = null;
    if (config.aiKeySecret) {
        keyCipher = createKeyCipher(config.aiKeySecret);
    }

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
        aiKeys: new AiKeyManager(knex, { cipher: keyCipher, verifyKey: verifyApiKey }),
        aiConversations: new AiConversationManager(knex),
    };
};
