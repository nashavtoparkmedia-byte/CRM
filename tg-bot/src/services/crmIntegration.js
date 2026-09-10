const http = require('http');
const https = require('https');
const logger = require('../utils/logger');

function concreteProviderId(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const normalized = String(value).trim();
    return normalized && normalized !== 'legacy' && normalized !== 'telegram-default'
        ? normalized
        : null;
}

function extractTelegramProviderEvidence(ctx) {
    // ctx.botInfo is populated by Telegraf from the live authenticated bot.
    // A configured account ID is not provider evidence and must never replace it.
    const providerAccountId = concreteProviderId(ctx.botInfo?.id);
    const providerUpdateId = concreteProviderId(ctx.update?.update_id);
    const providerMessageId = concreteProviderId(
        ctx.message?.message_id ?? ctx.callbackQuery?.message?.message_id,
    );
    const callbackQueryId = concreteProviderId(ctx.callbackQuery?.id);
    // update_id is unique within one live Bot API account and stable across
    // our delivery retries. Message IDs are only chat-local and one message
    // may produce several distinct callback updates.
    const providerEventId = providerUpdateId ? `update:${providerUpdateId}` : null;
    if (!providerAccountId || !providerUpdateId || !providerEventId) return null;

    const providerUnixSeconds = Number(
        ctx.message?.date ?? ctx.callbackQuery?.message?.date,
    );
    const observedAt = Number.isInteger(providerUnixSeconds) && providerUnixSeconds > 0
        ? new Date(providerUnixSeconds * 1000).toISOString()
        : null;
    return {
        providerAccountId,
        providerUpdateId,
        providerMessageId,
        callbackQueryId,
        providerEventId,
        observedAt,
    };
}

const DEFAULT_CRM_TELEGRAM_WEBHOOK_URL = 'http://localhost:3002/api/webhook/telegram';

function normalizeCrmTelegramWebhookUrl(value) {
    const configured = typeof value === 'string' && value.trim()
        ? value.trim()
        : DEFAULT_CRM_TELEGRAM_WEBHOOK_URL;
    try {
        const parsed = new URL(configured);
        if (parsed.pathname === '' || parsed.pathname === '/') {
            parsed.pathname = '/api/webhook/telegram';
        }
        return parsed.toString();
    } catch {
        // Preserve the invalid value so the existing request path fails closed
        // and is reported by the forwarding error handler.
        return configured;
    }
}

/**
 * Service to forward incoming Telegram events to the CRM system's Webhook.
 */
class CrmIntegrationService {
    constructor() {
        this.crmWebhookUrl = normalizeCrmTelegramWebhookUrl(process.env.CRM_WEBHOOK_URL);
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

                // Group chat metadata (for CRM group/private routing)
                const providerChat = ctx.message?.chat || ctx.callbackQuery?.message?.chat || ctx.chat;
                const chatId    = providerChat?.id;
                const chatType  = providerChat?.type;
                const chatTitle = providerChat?.title || null;
                const firstName = ctx.from?.first_name || null;
                const lastName  = ctx.from?.last_name || null;

                // PR-Ц: media attachments — собираем file_id и пробрасываем
                // в webhook CRM. CRM при необходимости резолвит через Bot API
                // (см. /api/tg-media proxy endpoint).
                const attachments = [];
                if (ctx.message) {
                    const m = ctx.message;
                    if (m.photo && m.photo.length > 0) {
                        const largest = m.photo[m.photo.length - 1];
                        attachments.push({
                            type: 'image',
                            fileId: largest.file_id,
                            mimeType: 'image/jpeg',
                            fileSize: largest.file_size || null,
                            width: largest.width, height: largest.height,
                        });
                        if (!text) text = m.caption || '[Фото]';
                    } else if (m.video) {
                        attachments.push({
                            type: 'video',
                            fileId: m.video.file_id,
                            mimeType: m.video.mime_type || 'video/mp4',
                            fileSize: m.video.file_size || null,
                            fileName: m.video.file_name || null,
                            width: m.video.width, height: m.video.height,
                            duration: m.video.duration,
                        });
                        if (!text) text = m.caption || '[Видео]';
                    } else if (m.voice) {
                        attachments.push({
                            type: 'voice',
                            fileId: m.voice.file_id,
                            mimeType: m.voice.mime_type || 'audio/ogg',
                            fileSize: m.voice.file_size || null,
                            duration: m.voice.duration,
                        });
                        if (!text) text = m.caption || '[Голосовое сообщение]';
                    } else if (m.audio) {
                        attachments.push({
                            type: 'audio',
                            fileId: m.audio.file_id,
                            mimeType: m.audio.mime_type || 'audio/mpeg',
                            fileSize: m.audio.file_size || null,
                            fileName: m.audio.file_name || null,
                            duration: m.audio.duration,
                        });
                        if (!text) text = m.caption || '[Аудио]';
                    } else if (m.document) {
                        attachments.push({
                            type: 'document',
                            fileId: m.document.file_id,
                            mimeType: m.document.mime_type || 'application/octet-stream',
                            fileSize: m.document.file_size || null,
                            fileName: m.document.file_name || 'document',
                        });
                        if (!text) text = m.caption || `[Документ: ${m.document.file_name || ''}]`;
                    } else if (m.sticker) {
                        attachments.push({
                            type: 'sticker',
                            fileId: m.sticker.file_id,
                            mimeType: m.sticker.is_animated ? 'application/x-tgsticker' : 'image/webp',
                            fileSize: m.sticker.file_size || null,
                            width: m.sticker.width, height: m.sticker.height,
                        });
                        if (!text) text = m.sticker.emoji || '[Стикер]';
                    } else if (m.video_note) {
                        attachments.push({
                            type: 'video',
                            fileId: m.video_note.file_id,
                            mimeType: 'video/mp4',
                            fileSize: m.video_note.file_size || null,
                            duration: m.video_note.duration,
                        });
                        if (!text) text = '[Видеосообщение]';
                    } else if (m.location) {
                        if (!text) text = `[Локация: ${m.location.latitude},${m.location.longitude}]`;
                    } else if (m.contact) {
                        if (!text) text = `[Контакт: ${m.contact.first_name || ''} ${m.contact.phone_number || ''}]`.trim();
                    }
                }

                if (!telegramId || !text) return resolve();

                const providerEvidence = extractTelegramProviderEvidence(ctx);
                const connectionId = String(process.env.CRM_TELEGRAM_CONNECTION_ID || process.env.TELEGRAM_CONNECTION_ID || '').trim();
                const signature = String(process.env.BOT_CRM_SECRET || '').trim();
                if (!providerEvidence || !connectionId || !signature) {
                    logger.error('[CRM IN] Refusing unbound webhook: live bot/update evidence, CRM Telegram connection, and BOT_CRM_SECRET are required');
                    return resolve();
                }

                const payload = {
                    providerAccountId: providerEvidence.providerAccountId,
                    connectionId: connectionId,
                    providerEventId: providerEvidence.providerEventId,
                    providerUpdateId: providerEvidence.providerUpdateId,
                    providerMessageId: providerEvidence.providerMessageId,
                    callbackQueryId: providerEvidence.callbackQueryId,
                    telegramId: telegramId.toString(),
                    text: text,
                    direction: direction,
                    username: username,
                    timestamp: providerEvidence.observedAt || new Date().toISOString(),
                    chatId: chatId?.toString() || null,
                    chatType: chatType || null,
                    chatTitle: chatTitle,
                    firstName: firstName,
                    lastName: lastName,
                    attachments: attachments.length > 0 ? attachments : undefined,  // PR-Ц
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
                        'Content-Length': Buffer.byteLength(data),
                        'x-bot-signature': signature
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
module.exports.CrmIntegrationService = CrmIntegrationService;
module.exports.extractTelegramProviderEvidence = extractTelegramProviderEvidence;
module.exports.normalizeCrmTelegramWebhookUrl = normalizeCrmTelegramWebhookUrl;
