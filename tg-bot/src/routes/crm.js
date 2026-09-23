const express = require('express');
const router = express.Router();
const bot = require('../bot'); // Import the Telegraf bot instance
const logger = require('../utils/logger');
const { createExactCrmBotDeliveryHandler } = require('../services/exactCrmBotDelivery');
const { createExactCrmBotFileHandler } = require('../services/exactCrmBotFile');

/**
 * CRM Integration Routes
 * These routes allow the external CRM system to interact with the Bot.
 */

// POST /api/bot/send-message
// Endpoint for the CRM to send custom messages or broadcast to Telegram users
router.post('/send-message', createExactCrmBotDeliveryHandler({ bot, logger }));

// POST /api/bot/file
// Endpoint for the CRM to read one file this bot received, by its file id. The
// bot token never leaves this process.
router.post('/file', createExactCrmBotFileHandler({ bot, logger }));

module.exports = router;
