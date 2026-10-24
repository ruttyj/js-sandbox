// Turns errors into JSON responses: { error: message, ...details }. Anything that isn't an
// HttpError is a bug, so it's logged and the client gets a generic 500.
import { HttpError } from '../errors.js';

export const notFoundHandler = (req, res) => {
    res.status(404).json({ error: 'Not found.' });
};

// Express recognises an error handler by its four parameters, so the unused `next` must stay.
export const errorHandler = (error, req, res, next) => {
    if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message, ...error.details });
        return;
    }

    // body-parser's errors (malformed JSON, body too large) carry their own 4xx status.
    const isClientError = error.status >= 400 && error.status < 500;
    if (isClientError) {
        res.status(error.status).json({ error: error.message });
        return;
    }

    console.error(error);
    res.status(500).json({ error: 'Something went wrong on the server.' });
};
