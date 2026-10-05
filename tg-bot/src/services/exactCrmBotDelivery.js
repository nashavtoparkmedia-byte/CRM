'use strict';

function concreteId(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const normalized = String(value).trim();
    return normalized && normalized !== 'legacy' && normalized !== 'telegram-default'
        ? normalized
        : null;
}

function privatePeer(value) {
    const normalized = concreteId(value);
    return normalized && /^\d+$/.test(normalized) && normalized !== '0' ? normalized : null;
}

function sanitizeInlineKeyboard(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('TELEGRAM_INLINE_KEYBOARD_INVALID');
    }
    return value.map(row => {
        if (!Array.isArray(row) || row.length === 0) {
            throw new Error('TELEGRAM_INLINE_KEYBOARD_INVALID');
        }
        return row.map(button => {
            if (!button || typeof button !== 'object' || Array.isArray(button)) {
                throw new Error('TELEGRAM_INLINE_KEYBOARD_INVALID');
            }
            const keys = Object.keys(button);
            const text = typeof button.text === 'string' ? button.text.trim() : '';
            const callbackData = typeof button.callback_data === 'string' && button.callback_data
                ? button.callback_data
                : null;
            const url = typeof button.url === 'string' && button.url ? button.url : null;
            if (
                !text
                || Number(Boolean(callbackData)) + Number(Boolean(url)) !== 1
                || keys.some(key => !['text', 'callback_data', 'url'].includes(key))
            ) {
                throw new Error('TELEGRAM_INLINE_KEYBOARD_INVALID');
            }
            return callbackData ? { text, callback_data: callbackData } : { text, url };
        });
    });
}

function responseStatus(error) {
    if (error.message === 'TELEGRAM_BOT_TRANSPORT_UNAUTHORIZED') return 401;
    if (error.message.endsWith('_INVALID') || error.message.includes('_UNPROVEN')) return 400;
    if (error.message.includes('_MISMATCH')) return 409;
    return 502;
}

function createExactCrmBotDeliveryHandler({ bot, logger, environment = process.env }) {
    return async function exactCrmBotDelivery(req, res) {
        let requestedPeer = null;
        try {
            const secret = concreteId(environment.BOT_CRM_SECRET);
            if (!secret || req.get('x-bot-signature') !== secret) {
                throw new Error('TELEGRAM_BOT_TRANSPORT_UNAUTHORIZED');
            }

            requestedPeer = privatePeer(req.body?.chatId);
            const requestedAccount = concreteId(req.body?.providerAccountId);
            const requestedConnection = concreteId(req.body?.connectionId);
            const liveConnection = concreteId(
                environment.CRM_TELEGRAM_CONNECTION_ID || environment.TELEGRAM_CONNECTION_ID,
            );
            const text = typeof req.body?.text === 'string' ? req.body.text : '';
            if (!requestedPeer) throw new Error('TELEGRAM_OUTBOUND_PEER_INVALID');
            if (!text) throw new Error('TELEGRAM_MESSAGE_INVALID');
            // The transport binding stays mandatory and canonical.
            if (!requestedConnection || !liveConnection) {
                throw new Error('TELEGRAM_BOT_CONNECTION_UNPROVEN');
            }
            if (requestedConnection !== liveConnection) {
                throw new Error('TELEGRAM_BOT_CONNECTION_MISMATCH');
            }
            const inlineKeyboard = sanitizeInlineKeyboard(req.body?.inlineKeyboard);

            // The provider account comes from the readiness-proven Bot identity:
            // botRuntime.ensureBotIdentity() assigns a validated live getMe result
            // to Telegraf's botInfo before any update or delivery is accepted. It
            // is never taken from configuration, and it is deliberately NOT
            // re-fetched per delivery — a lazy getMe here made every outbound send
            // depend on a fresh api.telegram.org round trip over an egress that
            // intermittently resets. A bot's own account id cannot change without
            // a new token, which restarts the process and re-proves identity.
            const liveAccount = concreteId(bot.botInfo?.id);
            if (!liveAccount) throw new Error('TELEGRAM_BOT_PROVIDER_ACCOUNT_UNPROVEN');
            // providerAccountId is OPTIONAL in the request. No production Telegram
            // conversation carries a provider-account stamp (measured: 0 of 219),
            // so `outbound.providerAccountId` is always null and Gravity omits the
            // field; demanding it rejected every CRM delivery with
            // TELEGRAM_BOT_PROVIDER_ACCOUNT_UNPROVEN while proving nothing. When a
            // caller DOES pin an account we still hold it to the proven identity,
            // which is the same asymmetry Gravity's own echo check already uses.
            if (requestedAccount && requestedAccount !== liveAccount) {
                throw new Error('TELEGRAM_BOT_PROVIDER_ACCOUNT_MISMATCH');
            }

            const result = await bot.telegram.sendMessage(requestedPeer, text, {
                parse_mode: 'Markdown',
                ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
            });
            const messageId = concreteId(result?.message_id);
            if (!messageId || !/^\d+$/.test(messageId) || messageId === '0') {
                throw new Error('TELEGRAM_BOT_DELIVERY_RESULT_UNPROVEN');
            }

            logger.info(`[CRM OUT] Delivered Bot API message to ${requestedPeer}`);
            return res.status(200).json({
                success: true,
                messageId,
                providerAccountId: liveAccount,
                connectionId: liveConnection,
            });
        } catch (error) {
            logger.error(`[CRM OUT] Bot API delivery blocked for ${requestedPeer || 'invalid-peer'}: ${error.message}`);
            return res.status(responseStatus(error)).json({ error: error.message });
        }
    };
}

module.exports = {
    concreteId,
    createExactCrmBotDeliveryHandler,
    sanitizeInlineKeyboard,
};
