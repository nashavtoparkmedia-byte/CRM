'use strict';

/**
 * M2A2-TG2B: the bot process reports the provider principal Telegram has
 * authenticated it as, over the existing authenticated bot -> CRM boundary.
 *
 * The bot owns no provider-account persistence. It observes a live getMe,
 * signs a canonical statement with a key derived from the shared bot secret,
 * and posts it to the CRM action endpoint. Everything else - durability,
 * freshness policy, replay rejection - is owner-side in telegram-channel.
 *
 * Nothing here may affect bot availability: every entry point returns a
 * promise that resolves, never rejects, and no caller awaits it.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');

const logger = require('../utils/logger');

const DOMAIN_V1 = 'yoko-telegram-provider-attestation:v1';
const ACTION_V1 = 'attest_provider_account';
const PROVIDER_USER_ID = /^[0-9]{1,64}$/u;
const REQUEST_TIMEOUT_MS = 10_000;
/** One observation per window is enough: the owner side keeps a 45 minute attestation. */
const MIN_OBSERVATION_INTERVAL_MS = 10 * 60 * 1000;

/**
 * The signing key is derived, so the shared bearer secret is never used
 * directly as a MAC key. The same derivation shape already exists for the
 * Telegram webhook secret in botRuntime.
 */
function deriveProviderAttestationKeyV1(secret) {
    return crypto.createHash('sha256').update(`${DOMAIN_V1}|${secret}`).digest();
}

/**
 * The exact bytes both sides sign. Field order is fixed, the separator is a
 * newline, and every field is a constrained charset that cannot contain one.
 */
function canonicalProviderAttestationV1(fields) {
    return [
        DOMAIN_V1,
        ACTION_V1,
        fields.providerUserId,
        fields.transportRef,
        fields.attestingInstanceId,
        String(fields.observedAt),
        fields.attestationId,
    ].join('\n');
}

function signProviderAttestationV1(canonical, secret) {
    return crypto.createHmac('sha256', deriveProviderAttestationKeyV1(secret)).update(canonical).digest('base64url');
}

function exactProviderUserId(value) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return null;
    const normalized = String(value).trim();
    return PROVIDER_USER_ID.test(normalized) && normalized !== '0' ? normalized : null;
}

/** The transport locator, taken from configuration. It is never the principal. */
function exactTransportRef(environment) {
    const configured = String(
        environment.CRM_TELEGRAM_CONNECTION_ID || environment.TELEGRAM_CONNECTION_ID || '',
    ).trim();
    return configured.length > 0 && configured.length <= 128 && !/[\p{Cc}]/u.test(configured) ? configured : null;
}

function crmActionUrl(environment) {
    if (environment.BOT_ACTIONS_URL) return environment.BOT_ACTIONS_URL;
    const forwarded = environment.CRM_WEBHOOK_URL;
    if (forwarded) {
        try {
            const parsed = new URL(forwarded);
            return `${parsed.protocol}//${parsed.host}/api/webhooks/bot`;
        } catch { /* fall through to the local default */ }
    }
    return 'http://localhost:3002/api/webhooks/bot';
}

function postAttestation(url, body, secret) {
    return new Promise((resolve) => {
        let parsed;
        try { parsed = new URL(url); } catch { return resolve({ ok: false, status: null }); }
        const payload = JSON.stringify(body);
        const transport = parsed.protocol === 'https:' ? https : http;
        let settled = false;
        const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
        const request = transport.request({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: `${parsed.pathname}${parsed.search}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'x-bot-signature': secret,
            },
        }, (response) => {
            response.resume();
            response.on('end', () => finish({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode }));
        });
        request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('provider attestation timeout')));
        request.on('error', () => finish({ ok: false, status: null }));
        request.write(payload);
        request.end();
    });
}

function createProviderAccountAttestationV1(options = {}) {
    const environment = options.env || process.env;
    const now = options.now || (() => Date.now());
    const uuid = options.randomUUID || (() => crypto.randomUUID());
    const send = options.post || postAttestation;
    const log = options.logger || logger;
    const minIntervalMs = options.minIntervalMs ?? MIN_OBSERVATION_INTERVAL_MS;

    // Minted once for this process. It identifies the runtime instance, and it
    // is never derived from the principal, the transport, a pid or a secret.
    const attestingInstanceId = uuid();
    let lastObservationAt = null;

    /** Returns the statement to send, or a reason it cannot be built. */
    function buildAttestation(me, timestamp) {
        const providerUserId = exactProviderUserId(me && me.id);
        if (!providerUserId) return { ok: false, reason: 'principal_unproven' };
        const transportRef = exactTransportRef(environment);
        if (!transportRef) return { ok: false, reason: 'transport_ref_unconfigured' };
        // A transport locator that equals the principal would make the provider
        // id an identity source for the transport. They are different entities.
        if (transportRef === providerUserId) return { ok: false, reason: 'transport_ref_is_principal' };
        const secret = String(environment.BOT_CRM_SECRET || '').trim();
        if (!secret) return { ok: false, reason: 'attestation_secret_unconfigured' };

        const payload = {
            domain: DOMAIN_V1,
            action: ACTION_V1,
            providerUserId,
            transportRef,
            attestingInstanceId,
            observedAt: timestamp,
            attestationId: uuid(),
        };
        const signature = signProviderAttestationV1(canonicalProviderAttestationV1(payload), secret);
        return { ok: true, payload: { ...payload, signature }, secret };
    }

    return {
        get attestingInstanceId() { return attestingInstanceId; },
        buildAttestation,
        /**
         * Reports one live observation. Never throws and is never awaited by a
         * bot runtime path; a failed report is dropped and the next live
         * observation reports again.
         */
        async observe(me, reason = 'unspecified') {
            try {
                const timestamp = now();
                if (lastObservationAt !== null && timestamp - lastObservationAt < minIntervalMs) {
                    return { sent: false, reason: 'rate_limited' };
                }
                const built = buildAttestation(me, timestamp);
                if (!built.ok) {
                    log.warn(`[provider-attestation] not reported: ${built.reason}`);
                    return { sent: false, reason: built.reason };
                }
                lastObservationAt = timestamp;
                const result = await send(crmActionUrl(environment), { action: ACTION_V1, payload: built.payload }, built.secret);
                if (!result.ok) {
                    log.warn(`[provider-attestation] CRM rejected the observation (status ${result.status ?? 'none'}; reason ${reason})`);
                }
                return { sent: true, ok: result.ok, status: result.status };
            } catch (error) {
                try { log.warn(`[provider-attestation] observation failed: ${error && error.message}`); } catch { /* never a second failure path */ }
                return { sent: false, reason: 'observation_failed' };
            }
        },
    };
}

const runtime = createProviderAccountAttestationV1();

/** Fire-and-forget entry point for the live getMe sites. */
function observeBotPrincipalV1(me, reason) {
    try {
        void runtime.observe(me, reason).catch(() => undefined);
    } catch {
        // The provider-account foundation must never affect the bot runtime.
    }
}

module.exports = {
    ACTION_V1,
    DOMAIN_V1,
    canonicalProviderAttestationV1,
    createProviderAccountAttestationV1,
    deriveProviderAttestationKeyV1,
    observeBotPrincipalV1,
    runtime,
    signProviderAttestationV1,
};
