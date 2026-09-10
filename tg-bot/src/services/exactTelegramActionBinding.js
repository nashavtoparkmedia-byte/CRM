'use strict';

/**
 * Bind a driver action to the bot account that received the Telegram update
 * and to this bot process' configured CRM connection. Empty values are kept
 * empty so the CRM authority boundary can fail closed.
 */
function exactTelegramActionBinding(ctx, environment = process.env) {
    return {
        providerAccountId: String(
            ctx?.botInfo?.id || '',
        ).trim(),
        connectionId: String(
            environment.CRM_TELEGRAM_CONNECTION_ID || environment.TELEGRAM_CONNECTION_ID || '',
        ).trim(),
    };
}

module.exports = { exactTelegramActionBinding };
