// Architectural regression for the finalize write order.
//
// The Call row is canonical. Conversation-intelligence events are a
// best-effort sidecar and must be attempted only after Call.update has
// completed. Keeping this as a source contract avoids coupling a pure
// unit suite to Next.js, Redis, or a database.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const finalizeRouteUrl = new URL(
    '../../../app/api/ai-calls/sessions/[id]/finalize/route.ts',
    import.meta.url,
)
const finalizeSource = readFileSync(finalizeRouteUrl, 'utf8')

test('finalize commits the canonical Call before persisting best-effort events', () => {
    const callUpdateIndex = finalizeSource.indexOf('.call.update({')
    const eventPersistIndex = finalizeSource.indexOf(
        'const eventsResult = await persistEvents({',
    )

    assert.notEqual(callUpdateIndex, -1, 'canonical Call.update must remain present')
    assert.notEqual(eventPersistIndex, -1, 'event sidecar persistence must remain present')
    assert.ok(
        callUpdateIndex < eventPersistIndex,
        'Call.update must complete before best-effort event persistence begins',
    )

    const persistCallEnd = finalizeSource.indexOf('\n    })', eventPersistIndex)
    const persistCall = finalizeSource.slice(eventPersistIndex, persistCallEnd)

    assert.match(persistCall, /\n\s+opsLog,$/)
    assert.doesNotMatch(persistCall, /opsLog:\s*\(\(/)
})
