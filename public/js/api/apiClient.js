// Calls to this app's own server (see server/routes/apiRoutes.js). Every call sends the
// X-Requested-With header the server requires on writes (server/middleware/security.js says why).
const API_HEADERS = { 'X-Requested-With': 'ge-tracker' };

// A response with an error status. body: the server's JSON ({ error, ...details }), or {} when
// it sent none. A 409's body.current is the record as the server has it now.
class ApiError extends Error {
    constructor(status, body) {
        super(body.error || `Request failed (HTTP ${status}).`);
        this.status = status;
        this.body = body;
    }
}

// The response's JSON, or null when it has none (204, or a non-JSON error page from a proxy).
const readApiResponseBody = async (response) => {
    const contentType = response.headers.get('content-type') || '';
    if (response.status === 204 || !contentType.includes('application/json')) {
        return null;
    }
    return response.json();
};

/**
 * Sends a request to the server; body (if given) is sent as JSON.
 * Resolves with the response's JSON (null when there is none). Rejects with an ApiError for an
 * error status, or a TypeError when the server couldn't be reached at all.
 */
const apiRequest = async (method, path, body) => {
    const options = { method, headers: { ...API_HEADERS }, credentials: 'same-origin' };
    if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }

    const response = await fetch(path, options);
    const data = await readApiResponseBody(response);
    if (!response.ok) {
        throw new ApiError(response.status, data || {});
    }
    return data;
};

const isConflictError = (error) => error instanceof ApiError && error.status === 409;
