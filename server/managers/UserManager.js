// Accounts. Every user signs in with Google; google_sub (Google's id for the account) is what
// identifies them, since an email address can change.

// The user as the browser sees it.
const toPublicUser = (row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
});

export class UserManager {
    constructor(knex) {
        this.knex = knex;
    }

    async findById(id) {
        const row = await this.knex('users').where({ id }).first();
        if (!row) {
            return null;
        }
        return toPublicUser(row);
    }

    // Creates the user on their first sign-in; afterwards keeps their name, email and picture up
    // to date with their Google account.
    async upsertBySub({ sub, email, name, avatarUrl }) {
        const profile = { email: email ?? null, name: name ?? null, avatar_url: avatarUrl ?? null };

        await this.knex('users')
            .insert({ ...profile, google_sub: sub })
            .onConflict('google_sub')
            .merge({ ...profile, updated_at: this.knex.fn.now() });

        const row = await this.knex('users').where({ google_sub: sub }).first();
        return toPublicUser(row);
    }
}
