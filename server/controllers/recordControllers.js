// HTTP handlers for the user's own records. Validation has already run (req.valid); the managers
// do the work and throw ConflictError on a stale version, which becomes a 409.

// Scopes, item tags, variable tags: PUT /:key, DELETE /:key?version=, PUT /order.
export const createCollectionController = (manager) => ({
    save: async (req, res) => {
        const result = await manager.save(req.user.id, req.valid.params.key, req.valid.body);
        res.json(result);
    },

    remove: async (req, res) => {
        await manager.remove(req.user.id, req.valid.params.key, req.valid.query.version);
        res.status(204).end();
    },

    reorder: async (req, res) => {
        await manager.reorder(req.user.id, req.valid.body.keys);
        res.status(204).end();
    },
});

// Globals and settings: GET /, PUT /.
export const createDocumentController = (manager) => ({
    get: async (req, res) => {
        res.json(await manager.get(req.user.id));
    },

    save: async (req, res) => {
        const result = await manager.save(req.user.id, req.valid.body);
        res.json(result);
    },
});

export const createStateController = ({ state }) => ({
    load: async (req, res) => {
        res.json(await state.load(req.user.id));
    },
});
