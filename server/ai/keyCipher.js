// Encrypts users' Anthropic API keys for storage, so a copy of the database alone doesn't give the
// keys away. AES-256-GCM with a fresh random IV per key; GCM's tag makes a tampered value fail to
// decrypt rather than decrypt to garbage.
//
// Stored form: "v1.<iv>.<tag>.<ciphertext>", each part base64url. The version prefix leaves room
// to change the scheme later without guessing how an old value was made.
import crypto from 'node:crypto';

const FORMAT_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

// The secret is a long random string from the environment, not a password, so HKDF (rather than
// a slow password hash) is enough to turn it into an AES key.
const deriveKey = (secret) => {
    const key = crypto.hkdfSync('sha256', secret, '', 'ge-tracker anthropic api keys', KEY_BYTES);
    return Buffer.from(key);
};

/**
 * @param {string} secret  config.aiKeySecret
 * @returns {{ encrypt: function(string): string, decrypt: function(string): string }}
 *   decrypt throws when the value was made with another secret or has been changed.
 */
export const createKeyCipher = (secret) => {
    const key = deriveKey(secret);

    const encrypt = (plaintext) => {
        const iv = crypto.randomBytes(IV_BYTES);
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        const encodedParts = [iv, tag, ciphertext].map(part => part.toString('base64url'));
        return [FORMAT_VERSION, ...encodedParts].join('.');
    };

    const decrypt = (stored) => {
        const [version, iv, tag, ciphertext] = stored.split('.');
        if (version !== FORMAT_VERSION) {
            throw new Error(`Unknown encrypted key format "${version}".`);
        }

        const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(ciphertext, 'base64url')),
            decipher.final(),
        ]);
        return plaintext.toString('utf8');
    };

    return { encrypt, decrypt };
};
