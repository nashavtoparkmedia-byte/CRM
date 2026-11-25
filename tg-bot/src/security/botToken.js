'use strict';

// Telegram bot tokens are numeric bot ids followed by a colon and a secret
// component. This rejects missing/placeholders/obviously malformed values
// before Telegraf is constructed; it never proves token ownership.
function getRequiredBotToken(value) {
    if (typeof value !== 'string' || !/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(value.trim())) {
        throw new Error('BOT_TOKEN_INVALID');
    }
    return value.trim();
}

module.exports = { getRequiredBotToken };
