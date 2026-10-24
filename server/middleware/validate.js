// Checks a request's params, query and/or body against zod schemas. The parsed values (with any
// coercion applied) are put on req.valid, so controllers only read checked input.
import { HttpError } from '../errors.js';

const formatIssues = (issues) => issues.map(issue => ({
    path: issue.path.join('.'),
    message: issue.message,
}));

/**
 * @param {{ params?: import('zod').ZodType, query?: import('zod').ZodType, body?: import('zod').ZodType }} schemas
 */
export const validate = (schemas) => (req, res, next) => {
    req.valid = {};

    for (const [part, schema] of Object.entries(schemas)) {
        const result = schema.safeParse(req[part] ?? {});
        if (!result.success) {
            throw new HttpError(400, `Invalid request ${part}.`, { issues: formatIssues(result.error.issues) });
        }
        req.valid[part] = result.data;
    }

    next();
};
