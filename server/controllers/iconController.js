// GET /icons/:name — an item icon by its wiki file name, from the server's cache. A 404 tells the
// browser to fall back to the Grand Exchange's own image.
import { HttpError, NotFoundError } from '../errors.js';
import { isValidIconName } from '../managers/IconManager.js';

// Icons rarely change on the wiki, so browsers may keep them for a week without asking again.
const ICON_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export const createIconController = ({ icons }) => ({
    get: async (req, res) => {
        const { name } = req.params;
        if (!isValidIconName(name)) {
            throw new HttpError(400, 'Invalid icon name.');
        }

        const icon = await icons.getIcon(name);
        if (!icon) {
            throw new NotFoundError('No such icon.');
        }

        res.set('Cache-Control', `public, max-age=${ICON_MAX_AGE_SECONDS}`);
        res.type(icon.contentType);
        res.sendFile(icon.filePath);
    },
});
