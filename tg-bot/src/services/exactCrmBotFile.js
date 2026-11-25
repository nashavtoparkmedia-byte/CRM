'use strict';

/**
 * Hands one file the bot received to the CRM, by its Telegram file id.
 *
 * A file id is meaningful to exactly one bot token, and that token lives here,
 * so the CRM cannot fetch the file itself. This endpoint is the narrow way in:
 * it authenticates with the same shared secret as the delivery endpoint,
 * accepts nothing but a file id, and answers with bytes or with a status.
 *
 * What never leaves this module: the bot token and the Telegram download URL
 * derived from it. They are not returned, not redirected to and not logged.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const { telegramFetch } = require('./telegramFetch');
const { constantTimeSecretEqual, isAcceptableBotCrmSecret } = require('../security/botCrmSecret');
const FETCH_TIMEOUT_MS = 12_000;
/** Telegram file ids are URL-safe base64. */
const FILE_ID = /^[A-Za-z0-9_-]{8,256}$/;

const CONTENT_TYPES = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
};

function concreteId(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const normalized = String(value).trim();
    return normalized || null;
}

/** The content type comes from the path Telegram itself chose, never from the caller. */
function contentTypeForPath(filePath) {
    const extension = String(filePath || '').split('.').pop();
    return CONTENT_TYPES[String(extension).toLowerCase()] ?? null;
}

async function readBoundedBody(response, maxBytes) {
    if (!response.body || typeof response.body.getReader !== 'function') {
        throw new Error('TELEGRAM_FILE_BODY_UNAVAILABLE');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => {});
                return null;
            }
            chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks, total);
    } finally {
        reader.releaseLock();
    }
}

function createExactCrmBotFileHandler({
    bot,
    logger,
    environment = process.env,
    maxBytes = MAX_BYTES,
    fetchImpl = telegramFetch,
}) {
    return async function exactCrmBotFile(req, res) {
        const secret = typeof environment.BOT_CRM_SECRET === 'string' ? environment.BOT_CRM_SECRET.trim() : '';
        if (!isAcceptableBotCrmSecret(secret) || !constantTimeSecretEqual(req.get('x-bot-signature'), secret)) {
            return res.status(401).json({ success: false, error: 'TELEGRAM_BOT_TRANSPORT_UNAUTHORIZED' });
        }

        const fileId = concreteId(req.body?.fileId);
        if (!fileId || !FILE_ID.test(fileId)) {
            return res.status(400).json({ success: false, error: 'TELEGRAM_FILE_ID_INVALID' });
        }

        let link;
        try {
            link = await bot.telegram.getFileLink(fileId);
        } catch (error) {
            // A file id the bot cannot resolve is a missing file, whatever
            // Telegram called it. Only the status code is recorded: Telegram's
            // own error text can quote the request URL, and that URL carries
            // the bot token.
            logger.warn(`[crmBotFile] getFile refused with status ${error?.response?.error_code ?? error?.code ?? 'unknown'}`);
            return res.status(404).json({ success: false, error: 'TELEGRAM_FILE_NOT_FOUND' });
        }

        const contentType = contentTypeForPath(link?.pathname ?? String(link ?? ''));
        if (!contentType) {
            return res.status(415).json({ success: false, error: 'TELEGRAM_FILE_UNSUPPORTED_MEDIA' });
        }

        let response;
        try {
            response = await fetchImpl(String(link), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        } catch (error) {
            logger.warn(`[crmBotFile] download failed: ${error?.name || 'error'}`);
            return res.status(502).json({ success: false, error: 'TELEGRAM_FILE_DOWNLOAD_FAILED' });
        }
        if (!response.ok) {
            logger.warn(`[crmBotFile] download status ${response.status}`);
            return res.status(response.status === 404 ? 404 : 502).json({
                success: false,
                error: response.status === 404 ? 'TELEGRAM_FILE_NOT_FOUND' : 'TELEGRAM_FILE_DOWNLOAD_FAILED',
            });
        }

        const declared = Number(response.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > maxBytes) {
            return res.status(413).json({ success: false, error: 'TELEGRAM_FILE_TOO_LARGE' });
        }

        let body;
        try {
            body = await readBoundedBody(response, maxBytes);
        } catch (error) {
            logger.warn(`[crmBotFile] body read failed: ${error?.name || 'error'}`);
            return res.status(502).json({ success: false, error: 'TELEGRAM_FILE_DOWNLOAD_FAILED' });
        }
        if (!body) {
            return res.status(413).json({ success: false, error: 'TELEGRAM_FILE_TOO_LARGE' });
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', String(body.byteLength));
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.status(200).end(body);
    };
}

module.exports = { createExactCrmBotFileHandler, MAX_BYTES, CONTENT_TYPES };
