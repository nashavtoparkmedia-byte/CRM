/**
 * Thin HTTP client for talking back to the CRM from the bridge.
 *
 *   resolveCallByUuid(fsUuid)         GET /api/ai-calls/sessions/by-fs-uuid/<fsUuid>
 *   appendTranscript(callId, role, text)
 *                                     POST /api/ai-calls/sessions/<callId>/transcript-item
 *   postState(callId, state)          POST /api/ai-calls/sessions/<callId>/state
 *   finalize(callId, payload)         POST /api/ai-calls/sessions/<callId>/finalize
 *   fetchKeys()                       GET /api/internal/ai-call-keys
 *
 * fetchKeys returns the plaintext provider keys that admins configured via
 * the CRM UI. Cached for 60 s in-process so the bridge doesn't hit Postgres
 * via Next on every PCM frame; invalidateKeysCache() refreshes immediately
 * (useful right after CHANNEL_PARK).
 *
 * Every request carries BRIDGE_SHARED_TOKEN when configured. CRM authenticates
 * the header and fails closed, so bridge and CRM deployments must configure the
 * same well-formed secret before these callbacks can succeed.
 */

const { retryFinalizeRequest, fetchOnce } = require('./retry-helpers')

const CRM_BASE_URL = process.env.CRM_BASE_URL ?? 'http://127.0.0.1:3002'
const BRIDGE_SHARED_TOKEN = process.env.BRIDGE_SHARED_TOKEN
const KEYS_CACHE_TTL_MS = Number(process.env.BRIDGE_KEYS_CACHE_TTL_MS ?? 60_000)
// Per-request timeout for non-finalize bridge → CRM calls (resolve,
// appendTranscript, postState, fetchKeys). All four are best-effort
// single-shot operations — no retry, just a bounded wait so a hung
// CRM can't block the bridge's hot paths (`ensureSessionForCall`,
// per-utterance transcript push, lifecycle state updates). 5 s is the
// same per-attempt budget the finalize retry uses; consistent ops
// behaviour across the bridge → CRM surface.
const BRIDGE_CRM_REQUEST_TIMEOUT_MS = 5000

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
    const res = await fetchOnce(
        `${CRM_BASE_URL}/api/ai-calls/sessions/by-fs-uuid/${encodeURIComponent(fsUuid)}`,
        directInit({ headers: { ...authHeaders() } }),
        BRIDGE_CRM_REQUEST_TIMEOUT_MS,
    )
    if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`CRM resolve failed: HTTP ${res.status} ${body.slice(0, 200)}`)
    }
    return res.json()
}

async function appendTranscript(callId, role, text) {
    try {
        await fetchOnce(
            `${CRM_BASE_URL}/api/ai-calls/sessions/${encodeURIComponent(callId)}/transcript-item`,
            directInit({
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ role, text }),
            }),
            BRIDGE_CRM_REQUEST_TIMEOUT_MS,
        )
    } catch (err) {
        // Soft failure by design — per-utterance transcript-item is
        // best-effort. AbortError lands here too (treated identical
        // to network error). No retry, no log spam: just one stderr
        // line and the call carries on.
        console.error(`[crm] transcript-item failed: ${err.message}`)
    }
}

/**
 * Push a CRM-canonical intermediate state transition (`greeting` /
 * `active` / `transferring`). The endpoint validates the allowlist
 * server-side and is idempotent — same-state POSTs and POSTs against
 * already-terminal calls are a no-op. So callers MAY safely call this
 * more than once for the same transition; we still keep server-side
 * call sites guarded to avoid unnecessary HTTP.
 *
 * Fire-and-forget by design: the response body is discarded, errors
 * land on stderr. We don't want bridge-side retry here — that would
 * race with the call's own state machine and risk rolling forward
 * after the dialog already moved on. Eventual consistency through the
 * structured opsLog stream is the canonical operator surface.
 */
async function postState(callId, state) {
    try {
        await fetchOnce(
            `${CRM_BASE_URL}/api/ai-calls/sessions/${encodeURIComponent(callId)}/state`,
            directInit({
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ state }),
            }),
            BRIDGE_CRM_REQUEST_TIMEOUT_MS,
        )
    } catch (err) {
        // Same shape as appendTranscript: bounded wait, soft failure,
        // single stderr line. The /state endpoint is idempotent on
        // the CRM side (PR #51) so a missed POST just leaves the row
        // at its previous canonical state — not a correctness issue.
        console.error(`[crm] postState ${state} for ${callId} failed: ${err.message}`)
    }
}

/**
 * POST `/api/ai-calls/sessions/<callId>/finalize` with retry.
 *
 * Until this PR a transient CRM blip at the moment of finalize would
 * leave the Call row stuck in `active`/`greeting` for 30 minutes
 * (until the PR #43 stale-session reaper swept it). The fixed retry
 * policy in `./retry-helpers.js` closes that gap for short outages
 * without turning finalize into a blocking dependency: 3 attempts,
 * 5 s per-attempt timeout, 500/1500 ms backoffs between them. 4xx
 * responses are NOT retried (caller-side errors — retry won't help).
 * Total worst-case ≈ 17 s.
 *
 * On final failure the helper throws; `server.js` already catches
 * that throw. The retry inside this function is a *consistency
 * improvement*, not a hard call-blocking dependency — if the CRM is
 * truly down for the full retry window the row is still picked up
 * by the stale-cleanup reaper.
 */
async function finalize(callId, payload) {
    const url = `${CRM_BASE_URL}/api/ai-calls/sessions/${encodeURIComponent(callId)}/finalize`
    const init = directInit({
        headers: { ...authHeaders() },
    })
    const r = await retryFinalizeRequest({ url, payload, init, callId })
    return r.body
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
        const res = await fetchOnce(
            `${CRM_BASE_URL}/api/internal/ai-call-keys`,
            directInit({ headers: { ...authHeaders() } }),
            BRIDGE_CRM_REQUEST_TIMEOUT_MS,
        )
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
        // Same short-TTL failure cache for timeouts (AbortError lands
        // here) as for HTTP non-2xx, so a hung CRM doesn't make us
        // hammer it every PCM frame. 5 s TTL means recovery within
        // one missed cycle once CRM is back.
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
    postState,
    finalize,
    fetchKeys,
    invalidateKeysCache,
    enabled: true, // CRM is always reachable in this deployment model
}
