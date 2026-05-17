/**
 * Thin HTTP client for talking back to the CRM from the bridge.
 *
 *   resolveCallByUuid(fsUuid)         GET /api/ai-calls/sessions/by-fs-uuid/<fsUuid>
 *   appendTranscript(callId, role, text)
 *                                     POST /api/ai-calls/sessions/<callId>/transcript-item
 *   finalize(callId, payload)         POST /api/ai-calls/sessions/<callId>/finalize
 *   fetchKeys()                       GET /api/internal/ai-call-keys
 *
 * fetchKeys returns the plaintext provider keys that admins configured via
 * the CRM UI. Cached for 60 s in-process so the bridge doesn't hit Postgres
 * via Next on every PCM frame; invalidateKeysCache() refreshes immediately
 * (useful right after CHANNEL_PARK).
 *
 * All endpoints are unauthenticated for MVP. When CRM grows real auth we'll
 * gate them by a shared secret (BRIDGE_SHARED_TOKEN — already wired here).
 */

const CRM_BASE_URL = process.env.CRM_BASE_URL ?? 'http://127.0.0.1:3002'
const BRIDGE_SHARED_TOKEN = process.env.BRIDGE_SHARED_TOKEN
const KEYS_CACHE_TTL_MS = Number(process.env.BRIDGE_KEYS_CACHE_TTL_MS ?? 60_000)

// Direct (proxy-free) undici dispatcher for talking to the local CRM. The
// process-wide globalDispatcher is a ProxyAgent pointing at Xray; if we
// inherit that for 127.0.0.1:3002 the request goes through the proxy and
// fails (Xray refuses local destinations). We build one Agent here and
// thread it through every fetch in this module via the `dispatcher`
// option. Lazily required so the file still works in environments where
// `undici` isn't installed.
let _directDispatcher = null
function directDispatcher() {
    if (_directDispatcher) return _directDispatcher
    try {
        const { Agent } = require('undici')
        _directDispatcher = new Agent()
    } catch (err) {
        console.warn(`[crm] could not load undici Agent for direct dispatcher: ${err.message}`)
        _directDispatcher = null
    }
    return _directDispatcher
}

function authHeaders() {
    return BRIDGE_SHARED_TOKEN ? { 'X-Bridge-Token': BRIDGE_SHARED_TOKEN } : {}
}

function directInit(init = {}) {
    const d = directDispatcher()
    return d ? { ...init, dispatcher: d } : init
}

async function resolveCallByUuid(fsUuid) {
    const res = await fetch(`${CRM_BASE_URL}/api/ai-calls/sessions/by-fs-uuid/${encodeURIComponent(fsUuid)}`, directInit({
        headers: { ...authHeaders() },
    }))
    if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`CRM resolve failed: HTTP ${res.status} ${body.slice(0, 200)}`)
    }
    return res.json()
}

async function appendTranscript(callId, role, text) {
    try {
        await fetch(`${CRM_BASE_URL}/api/ai-calls/sessions/${encodeURIComponent(callId)}/transcript-item`, directInit({
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ role, text }),
        }))
    } catch (err) {
        console.error(`[crm] transcript-item failed: ${err.message}`)
    }
}

async function finalize(callId, payload) {
    const res = await fetch(`${CRM_BASE_URL}/api/ai-calls/sessions/${encodeURIComponent(callId)}/finalize`, directInit({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload),
    }))
    if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`CRM finalize failed: HTTP ${res.status} ${body.slice(0, 200)}`)
    }
    return res.json().catch(() => ({}))
}

// ── Plaintext key cache, served from /api/internal/ai-call-keys ──────────────

let keysCache = null  // { value, expiresAt }

function emptyKeys() {
    return { openaiApiKey: null, yandexApiKey: null, yandexFolderId: null, mockMode: false }
}

async function fetchKeys() {
    const now = Date.now()
    if (keysCache && keysCache.expiresAt > now) return keysCache.value
    try {
        const res = await fetch(`${CRM_BASE_URL}/api/internal/ai-call-keys`, directInit({
            headers: { ...authHeaders() },
        }))
        if (!res.ok) {
            console.error(`[crm] fetchKeys HTTP ${res.status}`)
            // Cache the failure briefly so we don't hammer a misconfigured
            // endpoint, but with a short TTL so it recovers quickly.
            keysCache = { value: emptyKeys(), expiresAt: now + 5_000 }
            return keysCache.value
        }
        const data = await res.json()
        keysCache = { value: data, expiresAt: now + KEYS_CACHE_TTL_MS }
        return data
    } catch (err) {
        console.error(`[crm] fetchKeys error: ${err.message}`)
        keysCache = { value: emptyKeys(), expiresAt: now + 5_000 }
        return keysCache.value
    }
}

function invalidateKeysCache() {
    keysCache = null
}

module.exports = {
    resolveCallByUuid,
    appendTranscript,
    finalize,
    fetchKeys,
    invalidateKeysCache,
    enabled: true, // CRM is always reachable in this deployment model
}
