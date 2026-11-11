'use strict';

const { constantTimeEqual } = require('../middleware/auth');

function isAcceptableWebhookSecret(secret) {
    if (typeof secret !== 'string' || secret.length < 16 || secret.length > 256) return false;
    return !/(?:placeholder|replace[-_ ]?me|change[-_ ]?me|__generate)/i.test(secret.trim());
}

function requireTelegramWebhookSecret(req, res, next) {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!isAcceptableWebhookSecret(expected)) {
        return res.status(503).json({ error: 'Telegram webhook is not configured' });
    }

    const supplied = req.get('x-telegram-bot-api-secret-token');
    if (!supplied || !constantTimeEqual(supplied, expected)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    return next();
}

const BOT_CRM_SECRET_PLACEHOLDER = /(?:placeholder|replace[-_ ]?me|change[-_ ]?me|__generate)/i;

/**
 * The bot<->CRM shared secret (BOT_CRM_SECRET), or null when it is not strong.
 *
 * Both directions use it: the bot signs every CRM call with it, and the CRM
 * signs every delivery and file request it sends here. A missing, empty,
 * whitespace-padded, short (< 32), overlong or placeholder value is refused,
 * so a misconfigured process sends nothing and accepts nothing. There is no
 * fallback value. The CRM applies the same rule to the same variable.
 */
function acceptableBotCrmSecret(environment = process.env) {
    const secret = environment.BOT_CRM_SECRET;
    if (typeof secret !== 'string' || secret !== secret.trim()) return null;
    if (secret.length < 32 || secret.length > 256) return null;
    return BOT_CRM_SECRET_PLACEHOLDER.test(secret) ? null : secret;
}

/** Constant-time check of a supplied x-bot-signature against the strong secret. */
function isBotCrmSignatureValid(supplied, environment = process.env) {
    const expected = acceptableBotCrmSecret(environment);
    if (!expected || typeof supplied !== 'string' || supplied.length === 0) return false;
    return constantTimeEqual(supplied, expected);
}

module.exports = {
    acceptableBotCrmSecret,
    isAcceptableWebhookSecret,
    isBotCrmSignatureValid,
    requireTelegramWebhookSecret,
};
