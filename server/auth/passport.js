// Sign-in with Google (OAuth 2.0). The session stores only the user's id; each request loads the
// user from the database.
import passportModule from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';

export const isGoogleConfigured = (config) => Boolean(config.google.clientId && config.google.clientSecret);

// The parts of a Google profile the app keeps.
const profileToUser = (profile) => ({
    sub: profile.id,
    email: profile.emails?.[0]?.value,
    name: profile.displayName,
    avatarUrl: profile.photos?.[0]?.value,
});

// A Passport instance of its own (rather than the module's shared one), so each app built in the
// tests gets its own configuration.
export const createPassport = ({ config, users }) => {
    const passport = new passportModule.Passport();

    passport.serializeUser((user, done) => done(null, user.id));

    // A session whose user was deleted reads as signed out (false), not as an error.
    passport.deserializeUser((id, done) => {
        users.findById(id).then(
            (user) => done(null, user || false),
            (error) => done(error),
        );
    });

    if (isGoogleConfigured(config)) {
        const options = {
            clientID: config.google.clientId,
            clientSecret: config.google.clientSecret,
            callbackURL: `${config.baseUrl}/auth/google/callback`,
            // A random state kept in the session and checked on the way back, so another site
            // can't complete a sign-in into an account of its choosing.
            state: true,
        };
        const verify = (accessToken, refreshToken, profile, done) => {
            users.upsertBySub(profileToUser(profile)).then(
                (user) => done(null, user),
                (error) => done(error),
            );
        };
        passport.use(new GoogleStrategy(options, verify));
    }

    return passport;
};
