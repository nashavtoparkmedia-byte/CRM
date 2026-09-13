/**
 * One place to call the CRM's action webhook.
 *
 * carManagement.js and driverOrder.js each grew their own copy of this, and a
 * third copy in the compensation scene would be a third chance to point at the
 * wrong endpoint. The env resolution below is the same one those scenes use:
 * BOT_ACTIONS_URL wins, otherwise the CRM origin from the per-message
 * forwarder plus the action path, and localhost last.
 *
 * Note the two endpoints are different. /api/webhooks/bot takes actions;
 * /api/webhook/telegram is the per-message forwarder and must not be used here.
 */
const https = require('https');
const http = require('http');
const logger = require('../utils/logger');

const CRM_URL = () => {
    if (process.env.BOT_ACTIONS_URL) return process.env.BOT_ACTIONS_URL;
    const forwarder = process.env.CRM_WEBHOOK_URL;
    if (forwarder) {
        try {
            const parsed = new URL(forwarder);
            return `${parsed.protocol}//${parsed.host}/api/webhooks/bot`;
        } catch { /* fall through to localhost */ }
    }
    return 'http://localhost:3002/api/webhooks/bot';
};

const CRM_SECRET = () => process.env.BOT_WEBHOOK_SECRET || process.env.CRM_BOT_SECRET || '';

function postJSON(url, body, headers = {}) {
    return new Promise((resolve) => {
        const data = JSON.stringify(body);
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                ...headers,
            },
        };
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request(options, (res) => {
            let payload = '';
            res.on('data', (chunk) => { payload += chunk; });
            res.on('end', () => {
                try {
                    resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(payload) });
                } catch {
                    resolve({ ok: false, status: res.statusCode, data: { error: payload } });
                }
            });
        });
        req.setTimeout(15000, () => {
            req.destroy();
            resolve({ ok: false, status: 504, data: { error: 'timeout' } });
        });
        req.on('error', (error) => resolve({ ok: false, status: 0, data: { error: error.message } }));
        req.write(data);
        req.end();
    });
}

/**
 * Calls one CRM action and returns its body. A transport failure throws, so a
 * caller cannot mistake "the CRM never answered" for "the CRM said no".
 */
async function callCRM(action, payload) {
    const result = await postJSON(CRM_URL(), { action, payload }, { 'x-bot-signature': CRM_SECRET() });
    logger.info(`[crmAction] ${action}: status=${result.status}`);
    if (!result.ok) {
        throw new Error(`CRM action ${action} failed with status ${result.status}`);
    }
    return result.data;
}

module.exports = { callCRM, CRM_URL };
