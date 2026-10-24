// /auth/*: Google sign-in, the development sign-in, and signing out.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireApiHeader } from '../middleware/security.js';

// Generous for a person, low enough to slow down anyone hammering the sign-in flow.
const signInLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
});

export const createAuthRoutes = ({ auth }) => {
    const router = Router();

    router.get('/google', signInLimiter, auth.startGoogle);
    router.get('/google/callback', signInLimiter, auth.googleCallback, auth.finishSignIn);
    router.get('/dev', signInLimiter, auth.devSignIn);
    router.post('/logout', requireApiHeader, auth.signOut);

    return router;
};
