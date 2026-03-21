const http = require('http');
const https = require('https');
const logger = require('../utils/logger');
const config = require('../config');

/**
 * Service to forward incoming Telegram events to the CRM system's Webhook.
 */
class CrmIntegrationService {
    constructor() {
        this.crmWebhookUrl = process.env.CRM_WEBHOOK_URL || 'http://localhost:3002/api/webhook/telegram';
        this.isEnabled = process.env.CRM_INTEGRATION_ENABLED !== 'false';
    }

    forwardMessageToCrm(ctx, direction = 'INCOMING', retryCount = 0) {
        return new Promise((resolve, reject) => {
            if (!this.isEnabled || !this.crmWebhookUrl) return resolve();

            const MAX_RETRIES = 3;
            const TIMEOUT_MS = 15000;

            try {
                const telegramId = ctx.from?.id;
                let text = ctx.message?.text || ctx.callbackQuery?.data;
                const username = ctx.from?.username;

                // Handle media messages that have no text/callback data
                if (!text && ctx.message) {
                    if (ctx.message.photo) text = '[Фото]';
                    else if (ctx.message.voice) text = '[Голосовое сообщение]';
                    else if (ctx.message.video) text = '[Видео]';
                    else if (ctx.message.document) text = '[Документ]';
                    else if (ctx.message.location) text = '[Локация]';
                    else if (ctx.message.contact) text = '[Контакт]';
                }

                if (!telegramId || !text) return resolve();

                const payload = {
                    telegramId: telegramId.toString(),
                    text: text,
                    direction: direction,
                    username: username,
                    timestamp: new Date().toISOString()
                };

                const parsed = new URL(this.crmWebhookUrl);
                const data = JSON.stringify(payload);
                const options = {
                    hostname: parsed.hostname,
                    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                    path: parsed.pathname + parsed.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data)
                    }
                };

                const lib = parsed.protocol === 'https:' ? https : http;
                const req = lib.request(options, (res) => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            logger.info(`[CRM IN] Forwarded message to CRM from ${telegramId}`);
                            resolve();
                        } else {
                            logger.error(`[CRM IN] Failed to forward to CRM. Status: ${res.statusCode}`);
                            this.handleRetry(ctx, direction, retryCount, MAX_RETRIES, resolve);
                        }
                    });
                });

                req.setTimeout(TIMEOUT_MS, () => {
                    req.destroy();
                    logger.error(`[CRM IN] Timeout forwarding to CRM for ${telegramId} (Attempt ${retryCount + 1})`);
                    this.handleRetry(ctx, direction, retryCount, MAX_RETRIES, resolve);
                });

                req.on('error', (error) => {
                    logger.error(`[CRM IN] Error forwarding to CRM: ${error.message}`);
                    this.handleRetry(ctx, direction, retryCount, MAX_RETRIES, resolve);
                });

                req.write(data);
                req.end();
            } catch (error) {
                logger.error(`[CRM IN] Error: ${error.message}`);
                resolve();
            }
        });
    }

    handleRetry(ctx, direction, retryCount, maxRetries, resolve) {
        if (retryCount < maxRetries) {
            const delay = 1000 * (retryCount + 1);
            logger.info(`[CRM IN] Retrying in ${delay}ms... (Attempt ${retryCount + 2}/${maxRetries + 1})`);
            setTimeout(() => {
                this.forwardMessageToCrm(ctx, direction, retryCount + 1).then(resolve);
            }, delay);
        } else {
            logger.error(`[CRM IN] Max retries reached. Message dropped.`);
            resolve();
        }
    }
}

module.exports = new CrmIntegrationService();
