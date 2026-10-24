// express-session store that keeps sessions in the `sessions` table, so sign-ins survive a
// restart of the container. Expired sessions are ignored when read and pruned periodically.
import session from 'express-session';

const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

// Runs a promise-returning store operation and reports it through express-session's callback.
const withCallback = (promise, callback) => {
    promise.then(
        (result) => callback?.(null, result),
        (error) => callback?.(error),
    );
};

export class KnexSessionStore extends session.Store {
    /**
     * @param {object} options
     * @param {import('knex').Knex} options.knex
     * @param {number} options.ttlMs  How long a session lasts when its cookie has no expiry.
     */
    constructor({ knex, ttlMs }) {
        super();
        this.knex = knex;
        this.ttlMs = ttlMs;
        // unref: the timer alone mustn't keep the process (or a test run) alive.
        this.pruneTimer = setInterval(() => this.prune().catch(console.error), PRUNE_INTERVAL_MS).unref();
    }

    expiryOf(sess) {
        const cookieExpiry = sess?.cookie?.expires;
        if (cookieExpiry) {
            return new Date(cookieExpiry).getTime();
        }
        return Date.now() + this.ttlMs;
    }

    get(sid, callback) {
        withCallback(this.read(sid), callback);
    }

    set(sid, sess, callback) {
        withCallback(this.write(sid, sess), callback);
    }

    touch(sid, sess, callback) {
        const update = this.knex('sessions').where({ sid }).update({ expires_at: this.expiryOf(sess) });
        withCallback(update, callback);
    }

    destroy(sid, callback) {
        withCallback(this.knex('sessions').where({ sid }).delete(), callback);
    }

    // The session, or null when there's none or it has expired.
    async read(sid) {
        const row = await this.knex('sessions').where({ sid }).first();
        if (!row || row.expires_at <= Date.now()) {
            return null;
        }
        return JSON.parse(row.sess);
    }

    async write(sid, sess) {
        const row = { sid, sess: JSON.stringify(sess), expires_at: this.expiryOf(sess) };
        await this.knex('sessions').insert(row).onConflict('sid').merge();
    }

    async prune() {
        await this.knex('sessions').where('expires_at', '<=', Date.now()).delete();
    }

    close() {
        clearInterval(this.pruneTimer);
    }
}
