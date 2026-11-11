const crypto = require('crypto');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../config');
const { resolveCrmWebhookUrl } = require('./crmWebhookUrl');
const { redactStartCommandText } = require('../security/redactSecrets');
const { acceptableBotCrmSecret } = require('../security/webhookAuth');

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

/**
 * Terminal outcomes of one forward attempt chain. The caller awaits these so a
 * forward is never left in flight after the update that produced it.
 */
const CRM_FORWARD_OUTCOME = {
    /** CRM accepted the provider event (2xx). */
    SUCCESS: 'success',
    /** Nothing forwardable in this update; no request was made. */
    SKIPPED: 'skipped',
    /** Local binding incomplete, so the request was refused before sending. */
    UNBOUND: 'unbound',
    /** CRM refused this exact event (4xx). Resending cannot change the answer. */
    TERMINAL_4XX: 'terminal_4xx',
    /** Transport stayed unavailable for the whole bounded retry budget. */
    RETRY_EXHAUSTED_TRANSIENT: 'retry_exhausted_transient',
    /** Refused for a reason that clears without the event changing (auth, rate, load): kept, redelivered later. */
    DEFERRED: 'deferred',
};

/**
 * Only transport faults and server-side faults may be retried.
 *
 * Every 4xx is the CRM refusing this exact event on its own terms — a bad
 * signature, an unbound payload, a rejected identity. The same bytes produce the
 * same answer, so retrying a 4xx only delays the report and, in the 401 case the
 * incident was made of, turns one refusal into four identical ones.
 */
function isRetryableStatus(statusCode) {
    return typeof statusCode === 'number' && statusCode >= 500;
}

/**
 * A refusal the same bytes would get again: the event itself is wrong
 * (400, 404, 409 conflict, 410, 413, 422). Only these drop an event.
 */
const TERMINAL_REFUSALS = new Set([400, 404, 409, 410, 413, 422]);
function isTerminalRefusal(statusCode) {
    return TERMINAL_REFUSALS.has(statusCode);
}

/**
 * Any other 4xx clears without the event changing: 401/403 while
 * BOT_CRM_SECRET is mismatched (for example during a rotation), 408/425/429
 * under load. Such an event is kept for redelivery, never dropped, and never
 * retried in line (the incident: a 401 hammered four times).
 */
function isDeferrableRefusal(statusCode) {
    return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 && !TERMINAL_REFUSALS.has(statusCode);
}

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Bounds of the durable redelivery outbox (T3-O). Rows hold a person's message
 * (PII at rest): each is deleted on a 2xx or terminal CRM answer, the table is
 * capped, and anything older than the age limit is purged.
 */
function redeliveryLimits(environment = process.env) {
    return Object.freeze({
        maxRows: positiveInteger(environment.BOT_CRM_OUTBOX_MAX_ROWS, 5000),
        maxAgeMs: positiveInteger(environment.BOT_CRM_OUTBOX_MAX_AGE_HOURS, 72) * 60 * 60 * 1000,
        firstDelayMs: 30_000,
        maxDelayMs: 15 * 60 * 1000,
        batch: 20,
    });
}

/** Backoff for the next redelivery attempt: 30 s doubling, capped at 15 min. */
function redeliveryDelayMs(attempts, limits) {
    return Math.min(limits.firstDelayMs * (2 ** Math.max(0, attempts)), limits.maxDelayMs);
}

/**
 * The outbox: one file per kept event in a directory beside the bot's SQLite
 * file (BOT_CRM_OUTBOX_DIR, default <dir of BOT_SQLITE_PATH>/crm-forward-outbox),
 * so it shares that volume and its protection. The directory is 0700 and every
 * file 0600, written atomically (temporary file, then rename). The name is the
 * sha256 of the provider event id, which the CRM already de-duplicates, so a
 * redelivery can never create a second message.
 */
function createFileCrmOutbox(directory, limits = redeliveryLimits()) {
    const fileFor = (eventKey) => path.join(directory, `${crypto.createHash('sha256').update(String(eventKey)).digest('hex')}.json`);
    let ready = null;
    const ensure = () => {
        // mkdir's mode does not tighten a directory that already exists, so chmod it.
        ready = ready || fsp.mkdir(directory, { recursive: true, mode: 0o700 }).then(() => fsp.chmod(directory, 0o700));
        return ready;
    };
    const names = async () => (await fsp.readdir(directory)).filter(name => /^[0-9a-f]{64}\.json$/.test(name));
    const readEntry = async (name) => {
        try {
            const entry = JSON.parse(await fsp.readFile(path.join(directory, name), 'utf8'));
            return entry && typeof entry.eventKey === 'string' && typeof entry.body === 'string' ? entry : null;
        } catch {
            return null;
        }
    };
    const write = async (entry) => {
        const target = fileFor(entry.eventKey);
        const temporary = `${target}.${process.pid}.tmp`;
        await fsp.writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
        await fsp.rename(temporary, target);
    };
    const unlink = async (file) => {
        try { await fsp.unlink(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    };
    return Object.freeze({
        limits,
        async put(eventKey, body, now) {
            await ensure();
            if ((await names()).length >= limits.maxRows) return { stored: false, reason: 'full' };
            try {
                await fsp.access(fileFor(eventKey));
                return { stored: true, duplicate: true };
            } catch {
                await write({ eventKey, body, attempts: 0, nextAt: now + limits.firstDelayMs, createdAt: now });
                return { stored: true, duplicate: false };
            }
        },
        async due(now) {
            await ensure();
            const entries = (await Promise.all((await names()).map(readEntry))).filter(Boolean);
            return entries.filter(entry => entry.nextAt <= now)
                .sort((a, b) => a.createdAt - b.createdAt || a.eventKey.localeCompare(b.eventKey))
                .slice(0, limits.batch)
                .map(entry => ({ eventKey: entry.eventKey, body: entry.body, attempts: entry.attempts }));
        },
        async remove(eventKey) {
            await ensure();
            await unlink(fileFor(eventKey));
        },
        async reschedule(eventKey, attempts, nextAt) {
            await ensure();
            const entry = await readEntry(path.basename(fileFor(eventKey)));
            if (entry) await write({ ...entry, attempts, nextAt });
        },
        async purgeExpired(now) {
            await ensure();
            let purged = 0;
            for (const name of await names()) {
                const entry = await readEntry(name);
                // An unreadable entry cannot be redelivered; it is purged with the expired ones.
                if (!entry || entry.createdAt < now - limits.maxAgeMs) {
                    await unlink(path.join(directory, name));
                    purged += 1;
                }
            }
            return purged;
        },
        async count() {
            await ensure();
            return (await names()).length;
        },
    });
}

/** The production outbox directory: beside the bot's SQLite file unless configured. */
function crmOutboxDirectory(environment = process.env) {
    if (environment.BOT_CRM_OUTBOX_DIR) return environment.BOT_CRM_OUTBOX_DIR;
    return path.join(path.dirname(environment.BOT_SQLITE_PATH || './database.sqlite'), 'crm-forward-outbox');
}

/**
 * Service to forward incoming Telegram events to the CRM system's Webhook.
 */
class CrmIntegrationService {
    constructor(options = {}) {
        this.crmWebhookUrl = resolveCrmWebhookUrl(process.env.CRM_WEBHOOK_URL);
        this.isEnabled = process.env.CRM_INTEGRATION_ENABLED !== 'false';
        // Without an outbox (tests of the bounded retry alone) an exhausted
        // event is reported but not kept; the production instance has one.
        this.outbox = options.outbox || null;
        this.now = options.now || (() => Date.now());
        this.draining = false;
    }

    forwardMessageToCrm(ctx, direction = 'INCOMING', retryCount = 0) {
        return new Promise((resolve) => {
            if (!this.isEnabled || !this.crmWebhookUrl) {
                return resolve({ outcome: CRM_FORWARD_OUTCOME.SKIPPED, reason: 'disabled' });
            }

            const MAX_RETRIES = 3;
            // Operational knob with a safe default. It exists so the timeout arm
            // is reachable in a bounded test; production leaves it unset.
            const configuredTimeout = Number.parseInt(process.env.BOT_CRM_FORWARD_TIMEOUT_MS || '', 10);
            const TIMEOUT_MS = Number.isInteger(configuredTimeout) && configuredTimeout > 0
                ? configuredTimeout
                : 15000;
            // `destroy()` on timeout also emits 'error', so without this a single
            // timeout would start two independent retry chains.
            let terminated = false;
            const terminate = (handler) => {
                if (terminated) return;
                terminated = true;
                handler();
            };

            try {
                const telegramId = ctx.from?.id;
                // A /start deep-link payload can carry a referral token; the CRM
                // receives the command only.
                let text = redactStartCommandText(ctx.message?.text) || ctx.callbackQuery?.data;
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

                if (!telegramId || !text) {
                    return resolve({
                        outcome: CRM_FORWARD_OUTCOME.SKIPPED,
                        reason: 'no_forwardable_content',
                    });
                }

                const providerEvidence = extractTelegramProviderEvidence(ctx);
                const connectionId = String(process.env.CRM_TELEGRAM_CONNECTION_ID || process.env.TELEGRAM_CONNECTION_ID || '').trim();
                const signature = acceptableBotCrmSecret() || '';
                if (!providerEvidence || !connectionId || !signature) {
                    logger.error('[CRM IN] Refusing unbound webhook: live bot/update evidence, CRM Telegram connection, and BOT_CRM_SECRET are required');
                    return resolve({
                        outcome: CRM_FORWARD_OUTCOME.UNBOUND,
                        reason: 'binding_incomplete',
                    });
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
                    username: username || null,
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
                    res.on('end', () => terminate(() => {
                        const status = res.statusCode;
                        if (status >= 200 && status < 300) {
                            logger.info(`[CRM IN] Forwarded message to CRM from ${telegramId}`);
                            return resolve({
                                outcome: CRM_FORWARD_OUTCOME.SUCCESS,
                                status,
                                attempts: retryCount + 1,
                            });
                        }
                        if (isDeferrableRefusal(status)) {
                            logger.warn(`[CRM IN] CRM refused auth/rate (status ${status}); event=${payload.providerEventId} kept, not retried in line`);
                            return this.keepForRedelivery({ eventKey: payload.providerEventId, body: data }).then((kept) => resolve({
                                outcome: CRM_FORWARD_OUTCOME.DEFERRED,
                                status,
                                attempts: retryCount + 1,
                                kept,
                            }));
                        }
                        if (!isRetryableStatus(status)) {
                            logger.error(`[CRM IN] CRM refused the event. Status: ${status}. Not retrying.`);
                            return resolve({
                                outcome: CRM_FORWARD_OUTCOME.TERMINAL_4XX,
                                status,
                                attempts: retryCount + 1,
                            });
                        }
                        logger.error(`[CRM IN] Failed to forward to CRM. Status: ${status}`);
                        this.handleRetry(ctx, direction, retryCount, MAX_RETRIES, resolve, { status }, { eventKey: payload.providerEventId, body: data });
                    }));
                });

                req.setTimeout(TIMEOUT_MS, () => terminate(() => {
                    req.destroy();
                    logger.error(`[CRM IN] Timeout forwarding to CRM for ${telegramId} (Attempt ${retryCount + 1})`);
                    this.handleRetry(ctx, direction, retryCount, MAX_RETRIES, resolve, { reason: 'timeout' }, { eventKey: payload.providerEventId, body: data });
                }));

                req.on('error', (error) => terminate(() => {
                    logger.error(`[CRM IN] Error forwarding to CRM: ${error.message}`);
                    this.handleRetry(ctx, direction, retryCount, MAX_RETRIES, resolve, { reason: 'transport_error' }, { eventKey: payload.providerEventId, body: data });
                }));

                req.write(data);
                req.end();
            } catch (error) {
                logger.error(`[CRM IN] Error: ${error.message}`);
                resolve({ outcome: CRM_FORWARD_OUTCOME.SKIPPED, reason: 'local_exception' });
            }
        });
    }

    handleRetry(ctx, direction, retryCount, maxRetries, resolve, detail = {}, redelivery = null) {
        if (retryCount < maxRetries) {
            const delay = 1000 * (retryCount + 1);
            logger.info(`[CRM IN] Retrying in ${delay}ms... (Attempt ${retryCount + 2}/${maxRetries + 1})`);
            setTimeout(() => {
                this.forwardMessageToCrm(ctx, direction, retryCount + 1).then(resolve);
            }, delay);
            return;
        }
        const report = (kept) => resolve({
            outcome: CRM_FORWARD_OUTCOME.RETRY_EXHAUSTED_TRANSIENT,
            attempts: retryCount + 1,
            kept,
            ...detail,
        });
        // The update is already consumed from Telegram, so this is the last
        // moment the event exists: keep its exact body for redelivery.
        logger.error('[CRM IN] Max retries reached.');
        this.keepForRedelivery(redelivery).then(report);
    }

    /** Keep one event's exact body for redelivery; resolves whether it was kept. Logs ids only. */
    keepForRedelivery(redelivery) {
        if (!this.outbox || !redelivery?.eventKey) {
            logger.error('[CRM IN] Message dropped (no redelivery outbox).');
            return Promise.resolve(false);
        }
        return this.outbox.put(redelivery.eventKey, redelivery.body, this.now()).then((result) => {
            if (result.stored) {
                logger.warn(`[CRM IN] event=${redelivery.eventKey} kept for redelivery`);
                return true;
            }
            logger.error(`[CRM IN] event=${redelivery.eventKey} NOT kept (outbox ${result.reason})`);
            return false;
        }, (error) => {
            logger.error(`[CRM IN] event=${redelivery.eventKey} NOT kept (outbox error ${error?.code || error?.name || 'unknown'})`);
            return false;
        });
    }

    /** One POST of an already-built body with the current strong secret. */
    postKeptBody(body) {
        return new Promise((resolve) => {
            const signature = acceptableBotCrmSecret();
            if (!signature || !this.crmWebhookUrl) return resolve({ status: null, reason: 'unbound' });
            const configuredTimeout = Number.parseInt(process.env.BOT_CRM_FORWARD_TIMEOUT_MS || '', 10);
            const timeoutMs = Number.isInteger(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 15000;
            let settled = false;
            const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
            try {
                const parsed = new URL(this.crmWebhookUrl);
                const lib = parsed.protocol === 'https:' ? https : http;
                const req = lib.request({
                    hostname: parsed.hostname,
                    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                    path: parsed.pathname + parsed.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                        'x-bot-signature': signature,
                    },
                }, (res) => {
                    res.resume();
                    res.on('end', () => settle({ status: res.statusCode }));
                });
                req.setTimeout(timeoutMs, () => { req.destroy(); settle({ status: null, reason: 'timeout' }); });
                req.on('error', () => settle({ status: null, reason: 'transport_error' }));
                req.write(body);
                req.end();
            } catch {
                settle({ status: null, reason: 'local_exception' });
            }
        });
    }

    /**
     * Redeliver due kept events once. A 2xx (including the CRM's duplicate
     * answer) or a terminal 4xx deletes the row; a transient answer reschedules
     * it with backoff. Expired rows are purged first. Logs carry ids only.
     */
    async drainRedeliveryOutbox() {
        if (!this.outbox || this.draining) return { skipped: true };
        this.draining = true;
        const summary = { delivered: 0, refused: 0, rescheduled: 0, purged: 0 };
        try {
            const limits = this.outbox.limits;
            const now = this.now();
            summary.purged = await this.outbox.purgeExpired(now);
            if (summary.purged > 0) logger.error(`[CRM OUTBOX] purged ${summary.purged} event(s) older than the age limit`);
            for (const row of await this.outbox.due(now)) {
                const answer = await this.postKeptBody(row.body);
                if (answer.status !== null && answer.status >= 200 && answer.status < 300) {
                    await this.outbox.remove(row.eventKey);
                    summary.delivered += 1;
                    logger.info(`[CRM OUTBOX] event=${row.eventKey} redelivered`);
                } else if (answer.status !== null && isTerminalRefusal(answer.status)) {
                    await this.outbox.remove(row.eventKey);
                    summary.refused += 1;
                    logger.error(`[CRM OUTBOX] event=${row.eventKey} refused by the CRM (status ${answer.status}); not retried`);
                } else {
                    if (isDeferrableRefusal(answer.status)) {
                        logger.warn(`[CRM OUTBOX] event=${row.eventKey} CRM refused auth/rate (status ${answer.status}); kept`);
                    }
                    const attempts = row.attempts + 1;
                    await this.outbox.reschedule(row.eventKey, attempts, this.now() + redeliveryDelayMs(attempts, limits));
                    summary.rescheduled += 1;
                    if (answer.reason === 'unbound') break;
                }
            }
        } catch (error) {
            logger.error(`[CRM OUTBOX] drain failed: ${error?.code || error?.name || 'unknown'}`);
        } finally {
            this.draining = false;
        }
        return summary;
    }

    /** Start the periodic redelivery (production instance only). */
    startRedeliveryDrainer(intervalMs = 30_000) {
        if (!this.outbox || this.drainTimer) return;
        this.drainTimer = setInterval(() => { this.drainRedeliveryOutbox(); }, intervalMs);
        if (typeof this.drainTimer.unref === 'function') this.drainTimer.unref();
    }
}

module.exports = new CrmIntegrationService({ outbox: createFileCrmOutbox(crmOutboxDirectory()) });
module.exports.createFileCrmOutbox = createFileCrmOutbox;
module.exports.crmOutboxDirectory = crmOutboxDirectory;
module.exports.redeliveryLimits = redeliveryLimits;
module.exports.redeliveryDelayMs = redeliveryDelayMs;
module.exports.CRM_FORWARD_OUTCOME = CRM_FORWARD_OUTCOME;
module.exports.isRetryableStatus = isRetryableStatus;
module.exports.isTerminalRefusal = isTerminalRefusal;
module.exports.isDeferrableRefusal = isDeferrableRefusal;
module.exports.CrmIntegrationService = CrmIntegrationService;
module.exports.extractTelegramProviderEvidence = extractTelegramProviderEvidence;
// The Telegram webhook origin normalisation now lives in its own unit-tested
// module. The former name stays exported so the identity ingress-evidence test
// keeps asserting the same behaviour against the single implementation.
module.exports.normalizeCrmTelegramWebhookUrl = resolveCrmWebhookUrl;
