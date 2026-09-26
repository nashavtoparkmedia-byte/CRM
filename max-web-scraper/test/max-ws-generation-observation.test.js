'use strict'

/**
 * M2A2-MAX1B0A — WS generation observation, proven without a browser or a database.
 *
 * Two things are under test. First, that a frame can be attributed to the exact
 * socket generation that delivered it and that only the MAX keepalive promotes a
 * generation to the data socket. Second, that none of this observation reaches the
 * product: the identity the product reads, the authority it checks, and the
 * inbound path it forwards on must all behave exactly as before.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const {
    MAX_WS_DIAGNOSTIC_STATES_V1,
    MAX_WS_KEEPALIVE_OPCODE_V1,
    MAX_WS_TELEMETRY_EVENTS_V1,
    censusOwnerEvidenceV1,
    createWsGenerationObservationV1,
    diagnosticOutcomeForCensusV1,
    isExactGenerationV1,
    usableOwnerV1,
} = require('../transport/ws-generation-observation')
const { TransportInterceptor } = require('../transport/TransportInterceptor')

const SCRAPER_ROOT = path.join(__dirname, '..')
const INTERCEPTOR_SOURCE = fs.readFileSync(path.join(SCRAPER_ROOT, 'transport/TransportInterceptor.js'), 'utf8')
const OBSERVATION_SOURCE = fs.readFileSync(path.join(SCRAPER_ROOT, 'transport/ws-generation-observation.js'), 'utf8')
const INDEX_SOURCE = fs.readFileSync(path.join(SCRAPER_ROOT, 'index.js'), 'utf8')

const OWNER_A = '902100000001'
const OWNER_B = '902100000002'

/** Silences (and returns) everything the runtime logs while fn executes. */
async function captureLogs(fn) {
    const lines = []
    const original = console.log
    const originalWarn = console.warn
    console.log = (...args) => lines.push(args.map(String).join(' '))
    console.warn = (...args) => lines.push(args.map(String).join(' '))
    try {
        const value = await fn(lines)
        return { value, lines }
    } finally {
        console.log = original
        console.warn = originalWarn
    }
}

/** An interceptor with a stubbed browser bridge. No page, no CDP, no network. */
function buildInterceptor(evaluate) {
    const transport = new TransportInterceptor()
    const calls = []
    transport._page = {
        evaluate: async (fn, arg) => {
            calls.push(arg)
            return evaluate === undefined ? { ok: true, generation: null } : evaluate(arg)
        },
    }
    return { transport, calls }
}

/** Frees any diagnostic timer a test deliberately left unresolved. */
function releasePending(transport) {
    for (const entry of transport._generationPendingReqs.values()) clearTimeout(entry.timeout)
    transport._generationPendingReqs.clear()
    for (const entry of transport._pendingReqs.values()) clearTimeout(entry.timeout)
    transport._pendingReqs.clear()
}

function keepalive(transport, generation) {
    transport._processDecodedFrame({ opcode: MAX_WS_KEEPALIVE_OPCODE_V1, cmd: 0, seq: 0, payload: {} }, generation)
}

function pendingKeys(transport) {
    return [...transport._generationPendingReqs.keys()]
}

test('1. two generations coexist and are tracked independently', () => {
    const observation = createWsGenerationObservationV1()
    observation.noteSocketCreated(1)
    observation.noteSocketCreated(2)
    observation.noteFrame(1, 19)
    observation.noteFrame(2, 19)
    assert.equal(observation.currentGeneration, 2)
    assert.equal(observation.dataGeneration, null)
    assert.equal(observation.roleOf(1), 'probe_candidate')
    assert.equal(observation.roleOf(2), 'probe_candidate')
    // A frame on the older generation is still attributed to it, not to the newest.
    assert.equal(observation.noteFrame(1, MAX_WS_KEEPALIVE_OPCODE_V1).classifiedData, true)
    assert.equal(observation.dataGeneration, 1)
    assert.equal(observation.roleOf(2), 'probe_candidate')
})

test('2. a probe generation never becomes data, whatever else it receives', () => {
    const observation = createWsGenerationObservationV1()
    observation.noteSocketCreated(7)
    for (const opcode of [6, 19, 32, 46, 16, 48, 53, 128]) observation.noteFrame(7, opcode)
    assert.equal(observation.roleOf(7), 'probe_candidate')
    assert.equal(observation.dataGeneration, null)
    assert.equal(observation.shouldRunDiagnostic(7), false)
    assert.equal(observation.snapshot().diagnosticState, 'idle')
})

test('3. the first keepalive is what classifies a generation as data', () => {
    const observation = createWsGenerationObservationV1()
    observation.noteSocketCreated(3)
    const first = observation.noteFrame(3, MAX_WS_KEEPALIVE_OPCODE_V1)
    assert.deepEqual(first, { accepted: true, classifiedData: true, supersededGeneration: null })
    const second = observation.noteFrame(3, MAX_WS_KEEPALIVE_OPCODE_V1)
    assert.equal(second.classifiedData, false, 'classification happens once per generation')
    assert.equal(observation.roleOf(3), 'data')
    assert.equal(observation.dataGeneration, 3)
})

test('4. a later generation with a keepalive supersedes the data generation', () => {
    const observation = createWsGenerationObservationV1()
    observation.noteSocketCreated(4)
    observation.noteFrame(4, MAX_WS_KEEPALIVE_OPCODE_V1)
    observation.noteSocketCreated(5)
    const promotion = observation.noteFrame(5, MAX_WS_KEEPALIVE_OPCODE_V1)
    assert.equal(promotion.classifiedData, true)
    assert.equal(promotion.supersededGeneration, 4)
    assert.equal(observation.dataGeneration, 5)
    // A late keepalive from the superseded generation cannot take the role back.
    const late = observation.noteFrame(4, MAX_WS_KEEPALIVE_OPCODE_V1)
    assert.equal(late.classifiedData, false)
    assert.equal(late.supersededGeneration, null)
    assert.equal(observation.dataGeneration, 5)
    assert.equal(observation.isCurrentDataGeneration(4), false)
})

test('5. exactly one diagnostic GET_CHATS per data generation', async () => {
    const { value } = await captureLogs(async () => {
        const { transport, calls } = buildInterceptor()
        keepalive(transport, 11)
        keepalive(transport, 11)
        keepalive(transport, 11)
        const keys = pendingKeys(transport)
        releasePending(transport)
        return { calls, keys }
    })
    assert.equal(value.calls.length, 1, 'one solicited frame only')
    assert.deepEqual(value.keys, ['11:501'])
})

test('6. a probe generation never triggers the diagnostic', async () => {
    const { value } = await captureLogs(async () => {
        const { transport, calls } = buildInterceptor()
        for (const opcode of [6, 19, 32, 48, 53]) {
            transport._processDecodedFrame({ opcode, cmd: 0, seq: 0, payload: {} }, 12)
        }
        const state = transport.maxWsGenerationObservationV1()
        releasePending(transport)
        return { calls, state }
    })
    assert.equal(value.calls.length, 0)
    assert.equal(value.state.dataGeneration, null)
    assert.equal(value.state.diagnosticState, 'idle')
})

test('7. the diagnostic is refused when the send target moved on', async () => {
    const { value } = await captureLogs(async () => {
        const { transport } = buildInterceptor(() => ({ ok: false, error: 'generation_superseded', generation: 14 }))
        keepalive(transport, 13)
        await new Promise(resolve => setImmediate(resolve))
        const state = transport.maxWsGenerationObservationV1()
        releasePending(transport)
        return state
    })
    assert.equal(value.diagnosticState, 'refused')
    assert.equal(value.principalProofObserved, false)
})

test('8. the diagnostic response is correlated by (generation, seq)', async () => {
    const { value } = await captureLogs(async () => {
        const { transport, calls } = buildInterceptor()
        keepalive(transport, 21)
        const [generation, seq] = pendingKeys(transport)[0].split(':').map(Number)
        transport._processDecodedFrame({
            opcode: 48,
            cmd: 1,
            seq,
            payload: { chats: [{ id: 1, owner: OWNER_A }, { id: 2, owner: OWNER_A }] },
        }, generation)
        await new Promise(resolve => setImmediate(resolve))
        const state = transport.maxWsGenerationObservationV1()
        releasePending(transport)
        return { state, sent: calls[0] }
    })
    assert.equal(value.state.diagnosticState, 'proof_observed')
    assert.equal(value.state.principalProofObserved, true)
    assert.equal(value.state.proofSource, 'solicited_get_chats_op48')
    assert.equal(value.state.ownerPresence, 'complete')
    assert.equal(value.state.ownerConsistency, 'single')
    assert.equal(value.state.dataGeneration, 21)
    assert.equal(Array.isArray(value.sent) && value.sent[1], 21, 'the expected generation went to the browser bridge')
})

test('9. a late response from another generation is discarded', async () => {
    const { value } = await captureLogs(async () => {
        const { transport } = buildInterceptor()
        keepalive(transport, 31)
        const [, seq] = pendingKeys(transport)[0].split(':').map(Number)
        // Same seq, older generation: must not resolve the waiter.
        const resolvedByOldGeneration = transport._resolveGenerationPendingReq(30, { opcode: 48, cmd: 1, seq, payload: { chats: [] } })
        const stillPending = pendingKeys(transport)
        const state = transport.maxWsGenerationObservationV1()
        releasePending(transport)
        return { resolvedByOldGeneration, stillPending, state }
    })
    assert.equal(value.resolvedByOldGeneration, false)
    assert.deepEqual(value.stillPending, ['31:501'])
    assert.equal(value.state.diagnosticState, 'started')
})

test('10. a response with no owner proves nothing', () => {
    const census = censusOwnerEvidenceV1({ chats: [{ id: 1 }, { id: 2 }] })
    assert.deepEqual(census, { hasChats: true, chats: 2, withOwner: 0, ownerPresence: 'none', ownerConsistency: 'none' })
    assert.equal(diagnosticOutcomeForCensusV1(census), 'no_owner')
    const missing = censusOwnerEvidenceV1({ notChats: true })
    assert.equal(missing.hasChats, false)
    assert.equal(diagnosticOutcomeForCensusV1(missing), 'no_owner')
})

test('11. partial owner presence is reported as partial', () => {
    const census = censusOwnerEvidenceV1({ chats: [{ id: 1, owner: OWNER_A }, { id: 2 }, { id: 3, owner: OWNER_A }] })
    assert.equal(census.ownerPresence, 'partial')
    assert.equal(census.ownerConsistency, 'single')
    assert.equal(census.withOwner, 2)
    assert.equal(diagnosticOutcomeForCensusV1(census), 'proof_observed')
})

test('12. agreeing owners are complete and single', () => {
    const asArray = censusOwnerEvidenceV1([{ id: 1, owner: OWNER_A }, { id: 2, owner: OWNER_A }])
    assert.equal(asArray.ownerPresence, 'complete')
    assert.equal(asArray.ownerConsistency, 'single')
    assert.equal(diagnosticOutcomeForCensusV1(asArray), 'proof_observed')
    // Sentinels and malformed values are not owners.
    for (const owner of ['legacy', 'max-default', '', ' 9021 ', null, {}]) {
        assert.equal(usableOwnerV1(owner), null)
    }
})

test('13. conflicting owners fail closed and never pick one', async () => {
    const census = censusOwnerEvidenceV1({ chats: [{ id: 1, owner: OWNER_A }, { id: 2, owner: OWNER_B }] })
    assert.equal(census.ownerConsistency, 'conflicting')
    assert.equal(diagnosticOutcomeForCensusV1(census), 'conflicting_owner')
    const { value } = await captureLogs(async () => {
        const { transport } = buildInterceptor()
        keepalive(transport, 41)
        const [generation, seq] = pendingKeys(transport)[0].split(':').map(Number)
        transport._processDecodedFrame({
            opcode: 48,
            cmd: 1,
            seq,
            payload: { chats: [{ id: 1, owner: OWNER_A }, { id: 2, owner: OWNER_B }] },
        }, generation)
        await new Promise(resolve => setImmediate(resolve))
        const state = transport.maxWsGenerationObservationV1()
        releasePending(transport)
        return state
    })
    assert.equal(value.diagnosticState, 'conflicting_owner')
    assert.equal(value.principalProofObserved, false)
    assert.equal(value.proofSource, null)
})

test('14. telemetry carries shapes and counts, never a principal', async () => {
    const { lines } = await captureLogs(async () => {
        const { transport } = buildInterceptor()
        transport._handleFrame(JSON.stringify({ __diag: 'ws_created', url: 'wss://example.invalid/websocket' }), 51)
        keepalive(transport, 51)
        const [generation, seq] = pendingKeys(transport)[0].split(':').map(Number)
        transport._processDecodedFrame({
            opcode: 48,
            cmd: 1,
            seq,
            payload: { chats: [{ id: 902100000003, owner: OWNER_A }] },
        }, generation)
        await new Promise(resolve => setImmediate(resolve))
        transport._handleFrame(JSON.stringify({ __diag: 'ws_closed' }), 51)
        releasePending(transport)
    })
    const telemetry = lines.filter(line => line.startsWith('[MAX_WS_GENERATION] '))
    const events = telemetry.map(line => line.split(' ')[1])
    assert.deepEqual(events, [
        'generation_created',
        'generation_classified_data',
        'diagnostic_get_chats_started',
        'diagnostic_get_chats_result',
        'generation_closed',
    ])
    for (const event of events) assert.ok(MAX_WS_TELEMETRY_EVENTS_V1.includes(event), event)
    const serialized = telemetry.join('\n')
    assert.ok(!serialized.includes(OWNER_A), 'no owner value in telemetry')
    assert.ok(!serialized.includes('902100000003'), 'no chat id in telemetry')
    for (const line of telemetry) {
        const fields = JSON.parse(line.slice(line.indexOf('{')))
        for (const key of Object.keys(fields)) {
            assert.ok([
                'generation', 'supersededGeneration', 'role', 'outcome',
                'chats', 'withOwner', 'ownerPresence', 'ownerConsistency', 'durationMs',
            ].includes(key), `unexpected telemetry field ${key}`)
        }
    }
})

test('15. _myUserId keeps exactly its previous semantics', async () => {
    await captureLogs(async () => {
        const { transport } = buildInterceptor()
        // op:19 without a profile leaves it untouched, as before.
        transport._processDecodedFrame({ opcode: 19, cmd: 2, seq: 2, payload: { text: 'x' } }, 61)
        assert.equal(transport._myUserId, null)
        // op:53 owner fills it only while empty, as before.
        transport._processDecodedFrame({ opcode: 53, cmd: 6, seq: 3, payload: { chats: [{ id: 1, owner: OWNER_A }] } }, 61)
        assert.equal(transport._myUserId, OWNER_A)
        transport._processDecodedFrame({ opcode: 53, cmd: 6, seq: 4, payload: { chats: [{ id: 2, owner: OWNER_B }] } }, 61)
        assert.equal(transport._myUserId, OWNER_A, 'op:53 still cannot replace a known principal')
        // op:19 with a profile still overwrites it, as before.
        transport._processDecodedFrame({ opcode: 19, cmd: 0, seq: 5, payload: { profile: { contact: { id: OWNER_B } } } }, 61)
        assert.equal(transport._myUserId, OWNER_B)
        releasePending(transport)
    })
})

test('16. isAuthenticated() is untouched by generation state', async () => {
    await captureLogs(async () => {
        const { transport } = buildInterceptor()
        assert.equal(transport.isAuthenticated(), false)
        transport._processDecodedFrame({ opcode: 53, cmd: 6, seq: 3, payload: { chats: [{ id: 1, owner: OWNER_A }] } }, 71)
        assert.equal(transport.isAuthenticated(), true)
        // A data generation that opens, proves nothing and closes changes nothing.
        keepalive(transport, 71)
        transport._handleFrame(JSON.stringify({ __diag: 'ws_closed' }), 71)
        assert.equal(transport.isAuthenticated(), true)
        assert.equal(transport.maxWsGenerationObservationV1().dataGenerationOpen, false)
        releasePending(transport)
    })
    assert.match(INTERCEPTOR_SOURCE, /isAuthenticated\(\) \{\n {4}return !!this\._myUserId\n {2}\}/u)
})

test('17. outbound authorization still reads the unchanged identity', () => {
    assert.match(
        INDEX_SOURCE,
        /function liveAuthenticatedMaxProviderAccountId\(\) \{\n {2}if \(!transport\?\.isAuthenticated\?\.\(\)\) return null\n {2}return normalizeExactMaxProviderAccountId\(transport\._myUserId\)\n\}/u,
    )
    const authorityRegion = INDEX_SOURCE.slice(
        INDEX_SOURCE.indexOf('function liveAuthenticatedMaxProviderAccountId'),
        INDEX_SOURCE.indexOf('function maxScraperWebhookHeaders'),
    )
    for (const name of ['maxWsGenerationObservationV1', 'transportObservation', 'dataGeneration', 'principalProof']) {
        assert.ok(!authorityRegion.includes(name), `authority must not consult ${name}`)
    }
})

test('18. inbound forwarding still gates on the unchanged authority', () => {
    const forwardRegion = INDEX_SOURCE.slice(
        INDEX_SOURCE.indexOf('async function forwardToWebhook'),
        INDEX_SOURCE.indexOf('trackImportedMessage(normalizedPayload.chatId'),
    )
    assert.ok(forwardRegion.includes('const providerAccountId = liveAuthenticatedMaxProviderAccountId()'))
    assert.ok(forwardRegion.includes("throw new Error('MAX_PROVIDER_ACCOUNT_UNPROVEN')"))
    for (const name of ['maxWsGenerationObservationV1', 'dataGeneration', 'principalProofObserved']) {
        assert.ok(!forwardRegion.includes(name), `inbound must not consult ${name}`)
    }
})

test('19. the observation imports no database and no MAX1A writer', () => {
    for (const source of [OBSERVATION_SOURCE, INTERCEPTOR_SOURCE]) {
        for (const forbidden of ['@prisma/client', 'prisma', 'max-account-writer', 'MaxAccount', 'MaxTransportBinding']) {
            assert.ok(!source.includes(forbidden), `must not reference ${forbidden}`)
        }
    }
    assert.deepEqual(
        [...OBSERVATION_SOURCE.matchAll(/require\('([^']+)'\)/gu)].map(match => match[1]),
        [],
        'the decision module has no dependencies at all',
    )
})

test('20. nothing here attests, persists or configures MAX1B', () => {
    for (const source of [OBSERVATION_SOURCE, INTERCEPTOR_SOURCE]) {
        for (const forbidden of [
            'MAX_TRANSPORT_REF', 'MAX_SCRAPER_WEBHOOK_SECRET', 'attestation', 'attested',
            'recordMaxTransportAttestation', 'observeMaxProviderPrincipal',
        ]) {
            assert.ok(!source.includes(forbidden), `must not reference ${forbidden}`)
        }
    }
    // The diagnostic is the low-level frame, never the history workflow.
    assert.ok(INTERCEPTOR_SOURCE.includes('await this.sendFrame(OP.GET_CHATS, { chatIds: [] }, {'))
    for (const forbidden of ['runIfNeeded', '_fetchAllChats', 'InitialHistorySync', 'import-history', 'forwardToWebhook']) {
        assert.ok(!INTERCEPTOR_SOURCE.includes(forbidden), `diagnostic must not reach ${forbidden}`)
    }
})

test('declared vocabularies stay closed', () => {
    assert.deepEqual([...MAX_WS_DIAGNOSTIC_STATES_V1], [
        'idle', 'started', 'proof_observed', 'no_owner', 'conflicting_owner',
        'generation_superseded', 'timeout', 'refused', 'error',
    ])
    assert.equal(MAX_WS_KEEPALIVE_OPCODE_V1, 1)
    for (const generation of [0, -1, 1.5, '1', null, undefined, Number.NaN]) {
        assert.equal(isExactGenerationV1(generation), false)
    }
    assert.equal(isExactGenerationV1(1), true)
})
