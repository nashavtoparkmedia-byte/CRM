const express = require('express');
const botRuntime = require('../services/botRuntime');

const router = express.Router();

router.post('/webhook', async (req, res) => {
    const secret = req.get('x-telegram-bot-api-secret-token');
    if (!botRuntime.validateWebhookSecret(secret)) {
        return res.status(401).json({ error: 'Invalid Telegram webhook secret' });
    }

    try {
        const result = await botRuntime.handleUpdate(req.body);
        return res.status(200).json({ ok: true, duplicate: result.duplicate });
    } catch (error) {
        console.error('[Telegram webhook] update failed:', error);
        return res.status(500).json({ ok: false });
    }
});

module.exports = router;
