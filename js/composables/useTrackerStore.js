// Persisted app data (scopes, global variables and their code, variable tags, the user's item
// tags) and its localStorage load/save/migration.
const STORAGE_KEY = 'osrs-ge-tracker-data';
const OLD_GROUPS_KEY = 'osrs-ge-tracker-groups';
const OLD_GLOBALS_KEY = 'osrs-ge-tracker-globals';

// The raw saved data: { data: { groups, scopes, globals, globalsCode, tags, itemTags, itemTagEdits },
// fromOldKeys, failed }. groups and itemTagEdits only exist in data saved by older versions.
// globalsCode is null when none was saved. Data saved before everything shared one key is read
// from the old split keys (fromOldKeys). failed: the data exists but couldn't be parsed.
const readTrackerStorage = () => {
    const data = { groups: [], scopes: [], globals: [], globalsCode: null, tags: [], itemTags: [], itemTagEdits: {} };

    if (!localStorage.getItem(STORAGE_KEY)) {
        const oldGroups = readStoredJson(OLD_GROUPS_KEY, 'old groups');
        const oldGlobals = readStoredJson(OLD_GLOBALS_KEY, 'old globals');
        if (oldGroups) data.groups = oldGroups;
        if (oldGlobals) data.globals = oldGlobals;
        return { data, fromOldKeys: !!(oldGroups || oldGlobals), failed: false };
    }

    const parsed = readStoredJson(STORAGE_KEY, 'new data format');
    if (!parsed) return { data, fromOldKeys: false, failed: true };
    if (parsed.groups) data.groups = parsed.groups;
    if (parsed.scopes) data.scopes = parsed.scopes;
    if (parsed.globals) data.globals = parsed.globals;
    if (typeof parsed.globalsCode === 'string') data.globalsCode = parsed.globalsCode;
    if (parsed.tags) data.tags = parsed.tags;
    if (parsed.itemTags) data.itemTags = parsed.itemTags;
    if (parsed.itemTagEdits) data.itemTagEdits = parsed.itemTagEdits;
    return { data, fromOldKeys: false, failed: false };
};

const migrationMessage = (extractedScopeCount, migratedTagCount) => {
    if (migratedTagCount) {
        return "Item groups are now item tags (your own tags, on the Item Tags tab).";
    }
    if (extractedScopeCount) {
        return `Moved the recipes of ${extractedScopeCount} group(s) into Scopes.`;
    }
    return "Data migrated to new storage format.";
};

const useTrackerStore = ({ showToast }) => {
    const scopes = ref([]);
    const globalVariables = ref([]); // derived from globalsCode, like a scope's variables from its code
    const globalsCode = ref('');
    const tags = ref([]); // variable tags
    const itemTags = ref([]);

    const saveData = () => {
        const data = {
            scopes: scopes.value,
            globals: globalVariables.value,
            globalsCode: globalsCode.value,
            tags: tags.value,
            itemTags: itemTags.value,
        };
        writeStoredJson(STORAGE_KEY, data);
    };

    // Loads the saved data and brings anything saved by an older version up to date; if anything
    // had to change, the updated data is saved straight back.
    const loadSavedData = () => {
        const { data, fromOldKeys, failed } = readTrackerStorage();
        if (failed) showToast("Error loading data.", "error");

        // Groups saved before scopes existed carry their own recipes; move them into scopes.
        const extractedScopes = extractLegacyScopes(data.groups);
        data.scopes = [...data.scopes, ...extractedScopes];

        // groupsToItemTags migration: groups become item tags (a backup of the old data is kept).
        normalizeItemTagData(data);
        if (data.groups.length || Object.keys(data.itemTagEdits).length) {
            backupBeforeItemTagMigration(STORAGE_KEY);
        }
        const migratedGroups = migrateGroupsToItemTags(data);

        data.scopes.forEach(normalizeScope);
        data.globals.forEach(normalizeVariable);

        // Every tag used on a variable must exist in the tag list.
        const addedTags = addMissingTags(data.tags, [...data.scopes.flatMap(s => s.variables), ...data.globals]);

        // Globals saved before they were code only have variables.
        const loadedGlobalsCode = data.globalsCode
            ?? (data.globals.length ? generateScopeCode({ variables: data.globals }) : '');

        scopes.value = data.scopes;
        globalVariables.value = data.globals;
        globalsCode.value = loadedGlobalsCode;
        tags.value = data.tags;
        itemTags.value = data.itemTags;

        if (fromOldKeys || extractedScopes.length || addedTags || migratedGroups) {
            saveData();
            showToast(migrationMessage(extractedScopes.length, migratedGroups), "success");
        }
    };

    return { scopes, globalVariables, globalsCode, tags, itemTags, saveData, loadSavedData };
};
