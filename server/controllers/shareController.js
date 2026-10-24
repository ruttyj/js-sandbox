// Sharing a scope by link: the owner turns the link on and off; anyone with it can view, and a
// signed-in viewer can copy the scope into their own.
import { NotFoundError } from '../errors.js';

export const createShareController = ({ scopes, shares }) => ({
    share: async (req, res) => {
        const token = await scopes.share(req.user.id, req.valid.params.key);
        if (!token) {
            throw new NotFoundError('No such scope.');
        }
        res.json({ shareToken: token });
    },

    unshare: async (req, res) => {
        const found = await scopes.unshare(req.user.id, req.valid.params.key);
        if (!found) {
            throw new NotFoundError('No such scope.');
        }
        res.status(204).end();
    },

    view: async (req, res) => {
        res.json(await shares.view(req.valid.params.token));
    },

    copy: async (req, res) => {
        const record = await shares.copy(req.valid.params.token, req.user.id);
        res.status(201).json(record);
    },
});
