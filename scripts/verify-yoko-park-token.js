'use strict';

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const dotenv = require(path.resolve(__dirname, '../tg-bot/node_modules/dotenv'));
const { getRequiredBotToken } = require('../tg-bot/src/security/botToken');
const { createTelegramProxyAgent, getTelegramProxyConfig } = require('../tg-bot/src/services/telegramProxyAgent');

const tokenFile = path.resolve(__dirname, '../deploy/secrets/telegram-bot.env');
const config = dotenv.parse(fs.readFileSync(tokenFile));
const token = getRequiredBotToken(config.BOT_TOKEN);
const agent = createTelegramProxyAgent(getTelegramProxyConfig(config));
const request = https.get(`https://api.telegram.org/bot${token}/getMe`, { agent, timeout: 10_000 }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { if (body.length < 16_384) body += chunk; });
    response.on('end', () => {
        agent?.destroy();
        try {
            const result = JSON.parse(body);
            if (response.statusCode === 200 && result.ok === true && result.result?.username === 'yoko_park_bot') {
                console.log('TOKEN_IDENTITY=PASS (@yoko_park_bot)');
                return;
            }
        } catch { /* deliberately do not emit response bodies */ }
        console.error('TOKEN_IDENTITY=FAIL (token rejected or belongs to another bot)');
        process.exitCode = 1;
    });
});
request.on('timeout', () => request.destroy(new Error('timeout')));
request.on('error', () => {
    agent?.destroy();
    console.error('TOKEN_IDENTITY=ERROR (Telegram API request failed; token not logged)');
    process.exitCode = 1;
});
