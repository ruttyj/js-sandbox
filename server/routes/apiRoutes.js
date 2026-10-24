// /api/*: the signed-in user's data, plus the public view of a shared scope.
import { Router } from 'express';
import { requireApiHeader, requireAuth } from '../middleware/security.js';
import { validate } from '../middleware/validate.js';
import {
    collectionSaveBody, documentSaveBody, globalsData, itemTagData, keyParams, reorderBody, scopeData,
    settingsData, shareTokenParams, variableTagData, versionQuery,
} from '../validation/schemas.js';

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

export const createApiRoutes = ({ auth, state, scopes, itemTags, variableTags, globals, settings, shares }) => {
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

    return router;
};
