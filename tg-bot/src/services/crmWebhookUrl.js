/**
 * Resolution of CRM_WEBHOOK_URL for Telegram → CRM forwarding.
 *
 * Deployment configures CRM_WEBHOOK_URL as a bare origin (`http://gravity-mvp:3002`)
 * because the same origin is reused for several CRM callbacks. The sender builds
 * its request path from `new URL(...).pathname`, so a bare origin resolves to `/`
 * and every forwarded Telegram update would POST to the application root instead
 * of the webhook handler. Normalising here keeps that decision in one place and
 * leaves an explicitly configured path untouched.
 *
 * Kept dependency-free so it can be unit-tested without the bot runtime.
 */

const DEFAULT_WEBHOOK_PATH = '/api/webhook/telegram';
const FALLBACK_WEBHOOK_URL = `http://localhost:3002${DEFAULT_WEBHOOK_PATH}`;

function resolveCrmWebhookUrl(configured) {
    const raw = typeof configured === 'string' && configured.trim() !== ''
        ? configured.trim()
        : FALLBACK_WEBHOOK_URL;
    try {
        const parsed = new URL(raw);
        if (!parsed.pathname || parsed.pathname === '/') {
            parsed.pathname = DEFAULT_WEBHOOK_PATH;
        }
        return parsed.toString();
    } catch {
        return FALLBACK_WEBHOOK_URL;
    }
}

module.exports = { resolveCrmWebhookUrl, DEFAULT_WEBHOOK_PATH, FALLBACK_WEBHOOK_URL };
