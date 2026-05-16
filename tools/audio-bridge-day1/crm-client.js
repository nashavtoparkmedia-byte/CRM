/**
 * Thin HTTP client for talking back to the CRM from the bridge.
 *
 *   resolveCallByUuid(fsUuid)
 *     GET  /api/ai-calls/sessions/by-fs-uuid/<fsUuid>
 *     → { callId, scenarioId, scenario, driverId, contactId }
 *     The bridge calls this on CHANNEL_PARK to load the right scenario.
 *
 *   appendTranscript(callId, role, text)
 *     POST /api/ai-calls/sessions/<callId>/transcript-item
 *     Fire-and-forget; failures are logged but don't break the call.
 *
 *   finalize(callId, payload)
 *     POST /api/ai-calls/sessions/<callId>/finalize
 *     Bridge sends the final result (qualification + manager task + leadData
 *     + full transcript). CRM writes Call.aiAnalysis / aiSummary /
 *     aiSessionStatus and creates the Task (if asked).
 *
 * All endpoints are unauthenticated for MVP. When CRM grows real auth we'll
 * gate them by a shared secret (BRIDGE_SHARED_TOKEN).
 */

const CRM_BASE_URL = process.env.CRM_BASE_URL ?? 'http://127.0.0.1:3002'
const BRIDGE_SHARED_TOKEN = process.env.BRIDGE_SHARED_TOKEN

function authHeaders() {
    return BRIDGE_SHARED_TOKEN ? { 'X-Bridge-Token': BRIDGE_SHARED_TOKEN } : {}
}

async function resolveCallByUuid(fsUuid) {
    const res = await fetch(`${CRM_BASE_URL}/api/ai-calls/sessions/by-fs-uuid/${encodeURIComponent(fsUuid)}`, {
        headers: { ...authHeaders() },
    })
    if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`CRM resolve failed: HTTP ${res.status} ${body.slice(0, 200)}`)
    }
    return res.json()
}

async function appendTranscript(callId, role, text) {
    try {
        await fetch(`${CRM_BASE_URL}/api/ai-calls/sessions/${encodeURIComponent(callId)}/transcript-item`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ role, text }),
        })
    } catch (err) {
        console.error(`[crm] transcript-item failed: ${err.message}`)
    }
}

async function finalize(callId, payload) {
    const res = await fetch(`${CRM_BASE_URL}/api/ai-calls/sessions/${encodeURIComponent(callId)}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(payload),
    })
    if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`CRM finalize failed: HTTP ${res.status} ${body.slice(0, 200)}`)
    }
    return res.json().catch(() => ({}))
}

module.exports = {
    resolveCallByUuid,
    appendTranscript,
    finalize,
    enabled: true, // CRM is always reachable in this deployment model
}
