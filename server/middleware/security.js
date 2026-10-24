// Request guards: sign-in, and the header that keeps other sites from acting as the user.
import { HttpError } from '../errors.js';

// The browser app sends this on every API call. A page on another site can't: a form can't set
// headers, and a cross-origin fetch with a custom header needs a CORS preflight this server never
// approves. So a write without it didn't come from this app.
export const API_HEADER_NAME = 'X-Requested-With';
export const API_HEADER_VALUE = 'ge-tracker';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const requireApiHeader = (req, res, next) => {
    const isSafe = SAFE_METHODS.has(req.method);
    if (!isSafe && req.get(API_HEADER_NAME) !== API_HEADER_VALUE) {
        throw new HttpError(403, `Missing ${API_HEADER_NAME} header.`);
    }
    next();
};

export const requireAuth = (req, res, next) => {
    if (!req.user) {
        throw new HttpError(401, 'Sign in required.');
    }
    next();
};
