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
            if (!requestedAccount) throw new Error('TELEGRAM_BOT_PROVIDER_ACCOUNT_UNPROVEN');
            if (!requestedConnection || !liveConnection) {
                throw new Error('TELEGRAM_BOT_CONNECTION_UNPROVEN');
            }
            if (requestedConnection !== liveConnection) {
                throw new Error('TELEGRAM_BOT_CONNECTION_MISMATCH');
            }
            const inlineKeyboard = sanitizeInlineKeyboard(req.body?.inlineKeyboard);

            // This live call is the provider-account attestation. It must be
            // immediately before sendMessage and may not be replaced by env.
            const liveBot = await bot.telegram.getMe();
            const liveAccount = concreteId(liveBot?.id);
            if (!liveAccount) throw new Error('TELEGRAM_BOT_PROVIDER_ACCOUNT_UNPROVEN');
            if (requestedAccount !== liveAccount) {
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
