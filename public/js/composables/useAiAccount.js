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

/**
 * The picker's models grouped by provider: [{ provider, label, models }]. The server sends the
 * models most free requests per day first, so the groups keep that order too: the provider whose
 * model comes first is the top group.
 */
const groupAiModels = (models) => {
    const groups = [];
    for (const model of models) {
        let group = groups.find(candidate => candidate.provider === model.provider);
        if (!group) {
            const info = AI_PROVIDER_INFO.find(candidate => candidate.id === model.provider);
            group = { provider: model.provider, label: info?.label ?? model.provider, models: [] };
            groups.push(group);
        }
        group.models.push(model);
    }
    return groups;
};

// How roomy a free tier's daily limit is, as a colored dot: green for a day of steady use, yellow
// for a few chats, red for a handful of requests (a single chat with tool calls can use several).
const FREE_LIMIT_DOTS = [
    { minimumPerDay: 250, dot: '🟢' },
    { minimumPerDay: 50, dot: '🟡' },
    { minimumPerDay: 0, dot: '🔴' },
];

const freeLimitDot = (requestsPerDay) => {
    return FREE_LIMIT_DOTS.find(tier => requestsPerDay >= tier.minimumPerDay).dot;
};

// A model's line in the picker: "🟢 Gemini 3.5 Flash-Lite · 500/day" when it has free limits.
// Built as one string because an in-page template can't put elements inside an <option>.
const aiModelOptionLabel = (model) => {
    if (!model.freeLimits) {
        return model.label;
    }
    const perDay = model.freeLimits.requestsPerDay;
    return `${freeLimitDot(perDay)} ${model.label} · ${perDay.toLocaleString()}/day`;
};

// 250000 -> "250K", 14400 -> "14.4K", 500 -> "500".
const formatLimitNumber = (value) => {
    return new Intl.NumberFormat('en', { notation: 'compact' }).format(value);
};

// A model's hover text in the picker: its description and, for a free model, all its limits.
const aiModelOptionTitle = (model, providerLabel) => {
    if (!model.available) {
        return `Connect a ${providerLabel} key to use this`;
    }
    if (!model.freeLimits) {
        return model.description;
    }

    const { requestsPerMinute, tokensPerMinute, requestsPerDay } = model.freeLimits;
    const limits = `Free limits: ${requestsPerMinute} requests/min, ${formatLimitNumber(tokensPerMinute)} tokens/min, `
        + `${requestsPerDay.toLocaleString()} requests/day`;
    return `${model.description}\n${limits}`;
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
        aiStatus, aiProviders: AI_PROVIDER_INFO, aiModelGroups, aiModelOptionLabel, aiModelOptionTitle, currentAiModel, assistantName,
        isAiModalVisible, aiKeyInputs, aiKeyErrors, savingAiProvider, aiKeyButtonLabel,
        loadAiStatus, openAiModal, closeAiModal, connectAiKey, disconnectAiKey, setAiModel, markAiProviderDisconnected,
    };
};
