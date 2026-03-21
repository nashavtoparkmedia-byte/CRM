const express = require('express');
const router = express.Router();
const bot = require('../bot'); // Import the Telegraf bot instance
const logger = require('../utils/logger');

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

module.exports = router;
