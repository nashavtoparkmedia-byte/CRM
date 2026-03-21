/**
 * CRM Health Check Service
 * Checks if the CRM webhook is reachable.
 * Caches the result for 30 seconds to avoid hammering the server.
 */

const https = require('https');
const http = require('http');
const logger = require('../utils/logger');

const CRM_URL = () => process.env.CRM_WEBHOOK_URL || 'http://localhost:3002/api/webhooks/bot';

let _lastCheck = 0;
let _lastResult = null; // true = ok, false = down
const CACHE_MS = 30_000; // recheck at most every 30s

/**
 * Returns true if CRM is reachable, false otherwise.
 * Uses a lightweight HEAD-like POST with a bogus action (gets 400, but that means CRM is alive).
 */
async function isCrmAlive() {
    const now = Date.now();
    if (_lastResult !== null && now - _lastCheck < CACHE_MS) {
        return _lastResult;
    }

    try {
        const alive = await pingCrm();
        _lastResult = alive;
        _lastCheck = now;
        logger.info(`[CRM Health] status=${alive ? 'OK' : 'DOWN'}`);
        return alive;
    } catch (e) {
        _lastResult = false;
        _lastCheck = now;
        return false;
    }
}

function pingCrm() {
    return new Promise((resolve) => {
        const url = CRM_URL();
        let parsed;
        try { parsed = new URL(url); } catch { return resolve(false); }

        const data = JSON.stringify({ action: '__ping__', payload: {} });
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'x-bot-signature': process.env.BOT_CRM_SECRET || 'secret'
            }
        };

        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request(options, (res) => {
            // Any HTTP response (even 400 "Unknown action") means CRM is alive
            resolve(res.statusCode < 500 || res.statusCode === 400);
            res.resume(); // drain
        });

        req.setTimeout(5000, () => {
            req.destroy();
            resolve(false);
        });

        req.on('error', () => resolve(false));
        req.write(data);
        req.end();
    });
}

/** Invalidate the cache (force recheck on next call) */
function resetCache() {
    _lastResult = null;
    _lastCheck = 0;
}

module.exports = { isCrmAlive, resetCache };
