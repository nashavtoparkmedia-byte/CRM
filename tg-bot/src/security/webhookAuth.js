'use strict';

const { constantTimeEqual } = require('../middleware/auth');

function isAcceptableWebhookSecret(secret) {
    if (typeof secret !== 'string') return false;
    const value = secret.trim();
    if (value.length < 32 || value.length > 256) return false;
    if (/(?:placeholder|replace[-_ ]?me|change[-_ ]?me|__generate|your[-_ ]?secret)/i.test(value)) return false;
    return !/^(.)\1+$/.test(value);
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

module.exports = { isAcceptableWebhookSecret, requireTelegramWebhookSecret };
