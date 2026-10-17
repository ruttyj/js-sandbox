// Persisted app data (item groups, scopes, global variables and their code, tags) and its
// localStorage load/save/migration.
const STORAGE_KEY = 'osrs-ge-tracker-data';
const OLD_GROUPS_KEY = 'osrs-ge-tracker-groups';
const OLD_GLOBALS_KEY = 'osrs-ge-tracker-globals';

// JSON stored under key, or null when it's missing or can't be parsed.
const readStoredJson = (key, label) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        console.error(`Failed to parse ${label}`, e);
        return null;
    }
};

// The raw saved data: { data: { groups, scopes, globals, globalsCode, tags }, fromOldKeys, failed }.
// globalsCode is null when none was saved. Data saved before everything shared one key is read
// from the old split keys (fromOldKeys). failed: the data exists but couldn't be parsed.
const readTrackerStorage = () => {
    const data = { groups: [], scopes: [], globals: [], globalsCode: null, tags: [] };

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
    return { data, fromOldKeys: false, failed: false };
};

const useTrackerStore = ({ showToast }) => {
    const groups = ref([]);
    const scopes = ref([]);
    const globalVariables = ref([]); // derived from globalsCode, like a scope's variables from its code
    const globalsCode = ref('');
    const tags = ref([]);

    const saveData = () => {
        const data = {
            groups: groups.value,
            scopes: scopes.value,
            globals: globalVariables.value,
            globalsCode: globalsCode.value,
            tags: tags.value
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    };

    // Loads the saved data and brings anything saved by an older version up to date; if anything
    // had to change, the updated data is saved straight back.
    const loadSavedData = () => {
        const { data, fromOldKeys, failed } = readTrackerStorage();
        if (failed) showToast("Error loading data.", "error");

        // Groups saved before scopes existed carry their own recipes; move them into scopes.
        const extractedScopes = extractLegacyScopes(data.groups);
        data.scopes = [...data.scopes, ...extractedScopes];

        data.groups.forEach(normalizeGroup);
        data.scopes.forEach(normalizeScope);
        data.globals.forEach(normalizeVariable);

        // Every tag used on a variable must exist in the tag list.
        const addedTags = addMissingTags(data.tags, [...data.scopes.flatMap(s => s.variables), ...data.globals]);

        // Globals saved before they were code only have variables.
        const loadedGlobalsCode = data.globalsCode
            ?? (data.globals.length ? generateScopeCode({ variables: data.globals }) : '');

        groups.value = data.groups;
        scopes.value = data.scopes;
        globalVariables.value = data.globals;
        globalsCode.value = loadedGlobalsCode;
        tags.value = data.tags;

        if (fromOldKeys || extractedScopes.length || addedTags) {
            saveData();
            showToast(extractedScopes.length
                ? `Moved the recipes of ${extractedScopes.length} group(s) into Scopes.`
                : "Data migrated to new storage format.", "success");
        }
    };

    return { groups, scopes, globalVariables, globalsCode, tags, saveData, loadSavedData };
};
