const express = require('express');
const router = express.Router();
const bot = require('../bot'); // Import the Telegraf bot instance
const logger = require('../utils/logger');
const managerIdentification = require('../services/managerIdentification');

function hasValidCrmSignature(req) {
    const expectedSecret = process.env.BOT_CRM_SECRET;
    return Boolean(expectedSecret && req.get('x-bot-signature') === expectedSecret);
}

/**
 * CRM Integration Routes
 * These routes allow the external CRM system to interact with the Bot.
 */

// POST /api/bot/send-message
// Endpoint for the CRM to send custom messages or broadcast to Telegram users
router.post('/send-message', async (req, res) => {
    try {
        const { chatId, text, parseMode } = req.body;

        if (!chatId || !text) {
            return res.status(400).json({ error: 'Missing required fields: chatId, text' });
        }

        // Send the message via Telegraf
        const result = await bot.telegram.sendMessage(chatId, text, {
            parse_mode: parseMode || 'Markdown'
        });

        logger.info(`[CRM OUT] Delivered message to ${chatId}`);
        return res.status(200).json({ success: true, messageId: result.message_id });

    } catch (error) {
        logger.error(`[CRM OUT] Error sending message to ${req.body.chatId}:`, error.message);
        return res.status(500).json({ error: error.message });
    }
});

// POST /api/bot/manager-identification-message
// Sends one fixed, authenticated identification request to an unlinked user.
// The CRM cannot pass arbitrary text through this endpoint.
router.post('/manager-identification-message', async (req, res) => {
    if (!hasValidCrmSignature(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const telegramId = String(req.body?.chatId || '');
    if (!/^\d+$/.test(telegramId)) {
        return res.status(400).json({ error: 'Invalid chatId' });
    }

    try {
        const delivery = await managerIdentification.sendOnce(
            telegramId,
            'crm',
            message => bot.telegram.sendMessage(telegramId, message.text, message.extra)
        );

        if (delivery.alreadySent) {
            logger.info(`[CRM IDENTIFY] Identification request already sent to ${telegramId}`);
            return res.status(200).json({ success: true, alreadySent: true });
        }

        logger.info(`[CRM IDENTIFY] Delivered identification request to ${telegramId}`);
        return res.status(200).json({ success: true, messageId: delivery.result.message_id });
    } catch (error) {
        const message = error?.description || error?.message || String(error);
        logger.error(`[CRM IDENTIFY] Error sending to ${telegramId}: ${message}`);
        return res.status(502).json({ error: message });
    }
});

router.get('/profile/:telegramId', async (req, res) => {
    if (!hasValidCrmSignature(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const telegramId = String(req.params.telegramId || '');
    if (!/^\d+$/.test(telegramId)) {
        return res.status(400).json({ error: 'Invalid telegramId' });
    }

    try {
        const chat = await bot.telegram.getChat(telegramId);
        return res.json({
            telegramId,
            username: chat.username || null,
            firstName: chat.first_name || null,
            lastName: chat.last_name || null,
        });
    } catch (error) {
        const message = error?.description || error?.message || String(error);
        logger.warn(`[CRM PROFILE] Could not resolve ${telegramId}: ${message}`);
        const notFound = /chat not found|user not found/i.test(message);
        return res.status(notFound ? 404 : 502).json({ error: message });
    }
});

module.exports = router;
