// /api/*: the signed-in user's data, plus the public view of a shared scope.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireApiHeader, requireAuth } from '../middleware/security.js';
import { validate } from '../middleware/validate.js';
import {
    aiKeyBodies, aiModelBody, aiProviderParams, chatBody, collectionSaveBody, conversationParams, conversationSaveBody, documentSaveBody,
    globalsData, itemTagData, keyParams, reorderBody, scopeData, settingsData, shareTokenParams, variableTagData,
    versionQuery,
} from '../validation/schemas.js';

// Each key save makes a request to Anthropic; this keeps the server from being used to test
// stolen keys in bulk, while leaving plenty for a person fixing a typo.
const aiKeyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user.id),
});

// One chat message from the user can take many requests (one per round of tool calls), so this
// is generous; it's here to stop a runaway loop in the browser, not to ration the chat. The
// tokens are paid for by the user's own key either way.
const chatLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user.id),
});

// PUT /order, PUT /:key and DELETE /:key for one of the user's collections. /order is registered
// first so it isn't taken for a record whose key is "order".
const collectionRouter = (controller, dataSchema) => {
    const router = Router();
    router.put('/order', validate({ body: reorderBody }), controller.reorder);
    router.put('/:key', validate({ params: keyParams, body: collectionSaveBody(dataSchema) }), controller.save);
    router.delete('/:key', validate({ params: keyParams, query: versionQuery }), controller.remove);
    return router;
};

const documentRouter = (controller, dataSchema) => {
    const router = Router();
    router.get('/', controller.get);
    router.put('/', validate({ body: documentSaveBody(dataSchema) }), controller.save);
    return router;
};

// Each provider's keys have their own format; an unknown provider fails the params check first.
const validateAiKey = (req, res, next) => {
    const body = aiKeyBodies[req.params.provider] || aiKeyBodies.anthropic;
    validate({ params: aiProviderParams, body })(req, res, next);
};

const aiRouter = (controller) => {
    const router = Router();
    router.get('/', controller.status);
    router.put('/key/:provider', aiKeyLimiter, validateAiKey, controller.saveKey);
    router.delete('/key/:provider', validate({ params: aiProviderParams }), controller.removeKey);
    router.put('/model', validate({ body: aiModelBody }), controller.setModel);
    router.post('/chat', chatLimiter, validate({ body: chatBody }), controller.chat);

    router.get('/conversations', controller.listConversations);
    router.get('/conversations/:id', validate({ params: conversationParams }), controller.getConversation);
    router.put('/conversations/:id', validate({ params: conversationParams, body: conversationSaveBody }), controller.saveConversation);
    router.delete('/conversations/:id', validate({ params: conversationParams }), controller.removeConversation);
    return router;
};

export const createApiRoutes = ({ auth, state, scopes, itemTags, variableTags, globals, settings, shares, ai }) => {
    const router = Router();
    router.use(requireApiHeader);

    // Open to everyone: who's signed in, and shared scopes.
    router.get('/me', auth.me);
    router.get('/shared/:token', validate({ params: shareTokenParams }), shares.view);

    router.use(requireAuth);

    router.get('/state', state.load);
    router.post('/shared/:token/copy', validate({ params: shareTokenParams }), shares.copy);

    router.post('/scopes/:key/share', validate({ params: keyParams }), shares.share);
    router.delete('/scopes/:key/share', validate({ params: keyParams }), shares.unshare);
    router.use('/scopes', collectionRouter(scopes, scopeData));
    router.use('/item-tags', collectionRouter(itemTags, itemTagData));
    router.use('/variable-tags', collectionRouter(variableTags, variableTagData));

    router.use('/globals', documentRouter(globals, globalsData));
    router.use('/settings', documentRouter(settings, settingsData));
    router.use('/ai', aiRouter(ai));

    return router;
};
