'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require(path.resolve(__dirname, '../tg-bot/node_modules/dotenv'));
const { getRequiredBotToken } = require('../tg-bot/src/security/botToken');
const { createTelegramProxyAgent, getTelegramProxyConfig } = require('../tg-bot/src/services/telegramProxyAgent');

function readProxyConfig() {
    try {
        const secretFile = path.resolve(__dirname, '../deploy/secrets/telegram-bot.env');
        return dotenv.parse(fs.readFileSync(secretFile));
    } catch {
        return {};
    }
}

async function main() {
    const agent = createTelegramProxyAgent(getTelegramProxyConfig(readProxyConfig()));
    let token;
    try { token = getRequiredBotToken(await new Promise((resolve, reject) => {
        let input = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { input += chunk; });
        process.stdin.on('end', () => resolve(input.trim()));
        process.stdin.on('error', reject);
    })); }
    catch {
        console.error('TOKEN_INPUT=FAIL (missing, malformed, or no TTY)');
        process.exitCode = 1;
        return;
    }

    await new Promise((resolve) => {
        const request = https.get(`https://api.telegram.org/bot${token}/getMe`, { agent, timeout: 10_000 }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { if (body.length < 16_384) body += chunk; });
            response.on('end', () => {
                agent?.destroy();
                token = '';
                try {
                    const result = JSON.parse(body);
                    if (response.statusCode === 200 && result.ok === true && result.result?.username === 'yoko_park_bot') {
                        console.log('GETME=PASS username=@yoko_park_bot');
                    } else if (response.statusCode === 200 && result.ok === true) {
                        console.log('GETME=PASS username_mismatch; candidate is not @yoko_park_bot');
                        process.exitCode = 2;
                    } else {
                        console.log('GETME=FAIL token rejected');
                        process.exitCode = 1;
                    }
                } catch {
                    console.log('GETME=FAIL response unavailable');
                    process.exitCode = 1;
                }
                resolve();
            });
        });
        request.on('timeout', () => request.destroy(new Error('timeout')));
        request.on('error', () => {
            agent?.destroy();
            token = '';
            console.error('GETME=ERROR Telegram API connection failed; token not stored or logged');
            process.exitCode = 1;
            resolve();
        });
    });
}

main().catch(() => {
    console.error('GETME=ERROR diagnostic failed; token not stored or logged');
    process.exitCode = 1;
});
