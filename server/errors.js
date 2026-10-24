// Errors that carry the HTTP response they should become (see middleware/errorHandler.js).

export class HttpError extends Error {
    constructor(status, message, details = {}) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

export class NotFoundError extends HttpError {
    constructor(message = 'Not found.') {
        super(404, message);
    }
}

// A save based on a version that's no longer the latest. current: the record as the server has
// it now ({ version, data }), or null when it has since been deleted.
export class ConflictError extends HttpError {
    constructor(current) {
        super(409, 'This was changed somewhere else since it was loaded.', { current });
    }
}
