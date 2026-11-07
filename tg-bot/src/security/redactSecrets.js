'use strict';

const TELEGRAM_TOKEN_PATTERN = /\b\d{6,15}:[A-Za-z0-9_-]{20,}\b/g;
const BASIC_AUTH_PATTERN = /\bBasic\s+[A-Za-z0-9+/]+={0,2}/gi;
const SECRET_KEY_PATTERN = /^(?:authorization|cookie|set-cookie|api[-_]?key|apiHash|password|passphrase|credential|session(?:Data|String|Token)?|.*token|.*secret)$/i;

function redactText(value) {
    let text = String(value);
    for (const name of ['BOT_TOKEN', 'ADMIN_PASS', 'ADMIN_SESSION_SECRET', 'TELEGRAM_WEBHOOK_SECRET']) {
        const configuredSecret = process.env[name];
        if (configuredSecret) text = text.split(configuredSecret).join(`[REDACTED_${name}]`);
    }
    return text
        .replace(TELEGRAM_TOKEN_PATTERN, '[REDACTED_TELEGRAM_TOKEN]')
        .replace(BASIC_AUTH_PATTERN, 'Basic [REDACTED]');
}

function sanitizeLogValue(value, seen = new WeakSet()) {
    if (typeof value === 'string') return redactText(value);
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Error) return redactText(value.stack || value.message);
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) return value.map(item => sanitizeLogValue(item, seen));

    const clean = {};
    for (const [key, item] of Object.entries(value)) {
        clean[key] = SECRET_KEY_PATTERN.test(key)
            ? '[REDACTED]'
            : sanitizeLogValue(item, seen);
    }
    return clean;
}

/**
 * What may be recorded about a /start deep-link payload: only that there was
 * one. A payload can carry a referral token, so neither the payload nor a
 * digest of it reaches a log line or the action record: a digest would match
 * the referral ledger's code hash and link the Telegram account to the
 * inviter for anyone who can read both.
 */
function startPayloadEvidence(payload) {
    if (typeof payload !== 'string' || payload === '') return null;
    return { present: true };
}

/**
 * A /start command as it may leave the bot: the command without its deep-link
 * payload. Every other text, and a bare /start, is returned unchanged.
 */
function redactStartCommandText(text) {
    if (typeof text !== 'string') return text;
    const command = /^(\/start(?:@[A-Za-z0-9_]+)?)\s+\S/.exec(text);
    return command ? command[1] : text;
}

module.exports = { redactText, sanitizeLogValue, startPayloadEvidence, redactStartCommandText };
