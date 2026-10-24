// Connecting the user's own AI provider keys (Anthropic for Claude, Google for Gemini) so they can
// use the chat, billed to (or on the free tier of) their own account, and picking the chat's
// model. The server checks and keeps the keys; this side only ever learns which providers are
// connected and each key's last few characters (see server/managers/AiKeyManager.js).

// What the connect dialog shows for each provider.
const AI_PROVIDER_INFO = [
    {
        id: 'anthropic',
        label: 'Claude',
        keyUrl: 'https://console.anthropic.com/settings/keys',
        keySite: 'Anthropic Console',
        placeholder: 'sk-ant-...',
        note: 'Billed to your Anthropic API credits (a Claude.ai subscription doesn\'t cover it).',
    },
    {
        id: 'gemini',
        label: 'Gemini',
        keyUrl: 'https://aistudio.google.com/apikey',
        keySite: 'Google AI Studio',
        placeholder: 'AIza...',
        note: 'Free tier, with daily and per-minute limits. Google may use free-tier chats to improve its products.',
    },
];

const emptyAiStatus = () => ({ available: false, connected: false, providers: {}, model: null, models: [] });

// The picker's models grouped by provider: [{ provider, label, models }].
const groupAiModels = (models) => {
    return AI_PROVIDER_INFO
        .map(info => ({ provider: info.id, label: info.label, models: models.filter(model => model.provider === info.id) }))
        .filter(group => group.models.length);
};

// What to show under a key field when saving it failed.
const describeAiKeyError = (error) => {
    if (!(error instanceof ApiError)) {
        return 'Could not reach the server.';
    }

    // A 400 from validation names the field's problem in issues; the provider's refusal is in error.
    const issueMessage = error.body.issues?.[0]?.message;
    if (issueMessage) {
        return issueMessage;
    }
    return error.message;
};

const useAiAccount = ({ showToast }) => {
    const aiStatus = ref(emptyAiStatus());

    const isAiModalVisible = ref(false);
    const aiKeyInputs = ref({ anthropic: '', gemini: '' });
    const aiKeyErrors = ref({ anthropic: '', gemini: '' });
    const savingAiProvider = ref(null); // the provider whose key is being checked, or null

    // The model the chat uses, as the picker lists it, or null with nothing connected.
    const currentAiModel = computed(() => aiStatus.value.models.find(model => model.id === aiStatus.value.model) || null);
    // "Claude" or "Gemini": who the chat is talking to.
    const assistantName = computed(() => {
        const info = AI_PROVIDER_INFO.find(candidate => candidate.id === currentAiModel.value?.provider);
        return info ? info.label : 'AI';
    });
    const aiModelGroups = computed(() => groupAiModels(aiStatus.value.models));

    // The Connect button's label for a provider.
    const aiKeyButtonLabel = (provider) => {
        if (savingAiProvider.value === provider) {
            return 'Checking…';
        }
        if (aiStatus.value.providers[provider]?.connected) {
            return 'Replace';
        }
        return 'Connect';
    };

    const loadAiStatus = async () => {
        try {
            aiStatus.value = await apiRequest('GET', '/api/ai');
        } catch (error) {
            // The chat is an extra: the rest of the app works without knowing its status.
            console.error(error);
        }
    };

    const openAiModal = () => {
        aiKeyInputs.value = { anthropic: '', gemini: '' };
        aiKeyErrors.value = { anthropic: '', gemini: '' };
        isAiModalVisible.value = true;
    };

    const closeAiModal = () => {
        isAiModalVisible.value = false;
    };

    const connectAiKey = async (provider) => {
        const apiKey = aiKeyInputs.value[provider].trim();
        if (!apiKey || savingAiProvider.value) {
            return;
        }

        savingAiProvider.value = provider;
        aiKeyErrors.value[provider] = '';
        try {
            aiStatus.value = await apiRequest('PUT', `/api/ai/key/${provider}`, { apiKey });
            aiKeyInputs.value[provider] = '';
            showToast(`${AI_PROVIDER_INFO.find(info => info.id === provider).label} is connected.`, 'success');
        } catch (error) {
            aiKeyErrors.value[provider] = describeAiKeyError(error);
        } finally {
            savingAiProvider.value = null;
        }
    };

    const disconnectAiKey = async (provider) => {
        try {
            aiStatus.value = await apiRequest('DELETE', `/api/ai/key/${provider}`);
        } catch (error) {
            console.error(error);
            showToast('Could not disconnect that key.', 'error');
            return;
        }
        showToast('Disconnected, and the key was deleted from this app.', 'success');
    };

    const setAiModel = async (model) => {
        try {
            aiStatus.value = await apiRequest('PUT', '/api/ai/model', { model });
        } catch (error) {
            console.error(error);
            showToast('Could not change the model.', 'error');
        }
    };

    // A provider's key stopped working (the chat was refused): show it as disconnected.
    const markAiProviderDisconnected = (provider) => {
        const providers = { ...aiStatus.value.providers, [provider]: { connected: false, keyHint: null } };
        aiStatus.value = { ...aiStatus.value, providers, connected: Object.values(providers).some(entry => entry.connected) };
    };

    return {
        aiStatus, aiProviders: AI_PROVIDER_INFO, aiModelGroups, currentAiModel, assistantName,
        isAiModalVisible, aiKeyInputs, aiKeyErrors, savingAiProvider, aiKeyButtonLabel,
        loadAiStatus, openAiModal, closeAiModal, connectAiKey, disconnectAiKey, setAiModel, markAiProviderDisconnected,
    };
};
