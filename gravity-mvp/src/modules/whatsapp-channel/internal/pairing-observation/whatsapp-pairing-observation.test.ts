import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    classifyWhatsAppPairingObservationV1,
    readWhatsAppPairingObservationV1,
    readWhatsAppPairingPageStateV1,
    type WhatsAppPairingObservationClientV1,
    type WhatsAppPairingPageReadV1,
    type WhatsAppPairingPageStateV1,
} from './whatsapp-pairing-observation'
import {
    createWhatsAppPairingObserverV1,
    type WhatsAppPairingObservationRequestV1,
    type WhatsAppPairingObserverDependenciesV1,
} from './whatsapp-pairing-observer'
import {
    buildWhatsAppPairingTelemetryV1,
    WHATSAPP_PAIRING_TELEMETRY_FIELDS_V1,
    type WhatsAppPairingTelemetryInputV1,
} from './whatsapp-pairing-telemetry'

// Synthetic, obviously fake identifiers. The assertions below prove none of them reaches telemetry.
const PN_USER = '70000000001'
const LID_USER = '190000000000001'
const OTHER_PN_USER = '70000000002'
const OTHER_LID_USER = '190000000000002'
const SLOT_ID = 'cslotpairingobservation0001'
const WA_WEB_VERSION = '2.3000.1027587386'

function pageState(overrides: Partial<WhatsAppPairingPageStateV1> = {}): WhatsAppPairingPageStateV1 {
    return {
        moduleAvailable: true,
        socketState: 'CONNECTED',
        hasSynced: true,
        pn: { server: 'c.us', user: PN_USER, device: null, agent: null },
        pnReadFailed: false,
        lid: { server: 'lid', user: LID_USER, device: null, agent: null },
        lidReadFailed: false,
        waWebVersion: WA_WEB_VERSION,
        ...overrides,
    }
}

function pageRead(
    overrides: Partial<WhatsAppPairingPageStateV1> = {},
    infoWid: { server: unknown; user: unknown } | null = { server: 'c.us', user: PN_USER },
): WhatsAppPairingPageReadV1 {
    return { kind: 'page_state', state: pageState(overrides), infoWid }
}

const noTimers = {
    timeoutMs: 1_000,
    setTimer: () => null,
    clearTimer: () => undefined,
}

describe('classifyWhatsAppPairingObservationV1', () => {
    it('classifies a connected, synced, well-formed and consistent pair as complete', () => {
        const { flags, comparablePair } = classifyWhatsAppPairingObservationV1(pageRead())
        expect(flags).toEqual({
            outcome: 'complete',
            reasonClass: 'none',
            socketStateClass: 'connected',
            hasSynced: true,
            pnPresent: true,
            pnShapeValid: true,
            lidPresent: true,
            lidShapeValid: true,
            pnDiffersFromLid: true,
            infoWidMatchesPn: true,
            waWebVersion: WA_WEB_VERSION,
        })
        expect(comparablePair).toEqual({ pnUser: PN_USER, lidUser: LID_USER })
    })

    it.each([
        ['PN missing', { pn: null }, { outcome: 'partial', pnPresent: false, lidPresent: true }],
        ['LID missing', { lid: null }, { outcome: 'partial', pnPresent: true, lidPresent: false }],
        ['both missing', { pn: null, lid: null }, { outcome: 'partial', pnPresent: false, lidPresent: false }],
        ['PN on the lid server', { pn: { server: 'lid', user: PN_USER, device: null, agent: null } }, { outcome: 'invalid', pnShapeValid: false }],
        ['LID on the c.us server', { lid: { server: 'c.us', user: LID_USER, device: null, agent: null } }, { outcome: 'invalid', lidShapeValid: false }],
        ['PN with a device suffix', { pn: { server: 'c.us', user: PN_USER, device: 3, agent: null } }, { outcome: 'invalid', pnShapeValid: false }],
        ['LID with an agent part', { lid: { server: 'lid', user: LID_USER, device: null, agent: 1 } }, { outcome: 'invalid', lidShapeValid: false }],
        ['PN user carrying a device separator', { pn: { server: 'c.us', user: `${PN_USER}:3`, device: null, agent: null } }, { outcome: 'invalid', pnShapeValid: false }],
        ['LID user that is not digits', { lid: { server: 'lid', user: 'abc', device: null, agent: null } }, { outcome: 'invalid', lidShapeValid: false }],
        ['PN getter throwing', { pn: null, pnReadFailed: true }, { outcome: 'invalid', pnPresent: true, pnShapeValid: false }],
        ['LID getter throwing', { lid: null, lidReadFailed: true }, { outcome: 'invalid', lidPresent: true, lidShapeValid: false }],
        ['PN equal to LID', { lid: { server: 'lid', user: PN_USER, device: null, agent: null } }, { outcome: 'invalid', pnDiffersFromLid: false }],
    ] as const)('%s', (_label, overrides, expected) => {
        const { flags, comparablePair } = classifyWhatsAppPairingObservationV1(pageRead(overrides as Partial<WhatsAppPairingPageStateV1>))
        expect(flags).toMatchObject(expected)
        expect(comparablePair).toBeNull()
    })

    it.each([
        ['a different PN user', { server: 'c.us', user: OTHER_PN_USER }],
        ['the LID', { server: 'lid', user: LID_USER }],
        ['no wid at all', null],
    ] as const)('refuses a complete pair when client.info wid is %s', (_label, infoWid) => {
        const { flags, comparablePair } = classifyWhatsAppPairingObservationV1(pageRead({}, infoWid))
        expect(flags).toMatchObject({ outcome: 'invalid', infoWidMatchesPn: false })
        expect(comparablePair).toBeNull()
    })

    it.each([
        ['hasSynced false', { hasSynced: false }, 'connected'],
        ['an opening socket', { socketState: 'OPENING' }, 'opening'],
        ['an unpaired socket', { socketState: 'UNPAIRED' }, 'unpaired'],
        ['an unknown socket state', { socketState: null }, 'unknown'],
    ] as const)('gates %s without evaluating the keys', (_label, overrides, socketStateClass) => {
        const { flags, comparablePair } = classifyWhatsAppPairingObservationV1(pageRead(overrides as Partial<WhatsAppPairingPageStateV1>))
        expect(flags).toMatchObject({ outcome: 'gated', socketStateClass, pnPresent: null, lidPresent: null })
        expect(comparablePair).toBeNull()
    })

    it('reports unavailable, timeout and missing WhatsApp modules without evaluating the keys', () => {
        expect(classifyWhatsAppPairingObservationV1({ kind: 'unavailable', reasonClass: 'page_closed' }).flags)
            .toMatchObject({ outcome: 'unavailable', reasonClass: 'page_closed', pnPresent: null })
        expect(classifyWhatsAppPairingObservationV1({ kind: 'timeout' }).flags).toMatchObject({ outcome: 'timeout', pnPresent: null })
        expect(classifyWhatsAppPairingObservationV1(pageRead({ moduleAvailable: false })).flags)
            .toMatchObject({ outcome: 'unavailable', reasonClass: 'module_unavailable', pnPresent: null })
    })
})

describe('readWhatsAppPairingObservationV1', () => {
    const scope = globalThis as unknown as { require?: unknown; Debug?: unknown }
    const original = { require: scope.require, Debug: scope.Debug }

    afterEach(() => {
        scope.require = original.require
        scope.Debug = original.Debug
    })

    function installPage(options: { hasSynced?: boolean; state?: string } = {}) {
        const getMaybeMePnUser = vi.fn(() => ({ server: 'c.us', user: PN_USER, _serialized: `${PN_USER}@c.us` }))
        const getMaybeMeLidUser = vi.fn(() => ({ server: 'lid', user: LID_USER, _serialized: `${LID_USER}@lid` }))
        scope.Debug = { VERSION: WA_WEB_VERSION }
        scope.require = (name: string) => {
            if (name === 'WAWebSocketModel') return { Socket: { state: options.state ?? 'CONNECTED', hasSynced: options.hasSynced ?? true } }
            if (name === 'WAWebUserPrefsMeUser') return { getMaybeMePnUser, getMaybeMeLidUser }
            throw new Error(`unknown module ${name}`)
        }
        return { getMaybeMePnUser, getMaybeMeLidUser }
    }

    function clientWith(
        evaluate: (pageFunction: () => unknown) => Promise<unknown>,
        extra: Partial<{ isClosed: () => boolean; wid: { server: unknown; user: unknown } | null }> = {},
    ): WhatsAppPairingObservationClientV1 {
        return {
            pupPage: { evaluate, isClosed: extra.isClosed },
            info: { wid: extra.wid === undefined ? { server: 'c.us', user: PN_USER } : extra.wid },
        }
    }

    it('reads both getters once, synchronously, in the one page function it evaluates', async () => {
        const getters = installPage()
        const evaluate = vi.fn(async (pageFunction: () => unknown) => {
            const result = pageFunction()
            expect(result).not.toBeInstanceOf(Promise)
            return result
        })
        const read = await readWhatsAppPairingObservationV1(clientWith(evaluate), noTimers)
        expect(evaluate).toHaveBeenCalledTimes(1)
        expect(evaluate.mock.calls[0][0]).toBe(readWhatsAppPairingPageStateV1)
        expect(getters.getMaybeMePnUser).toHaveBeenCalledTimes(1)
        expect(getters.getMaybeMeLidUser).toHaveBeenCalledTimes(1)
        expect(classifyWhatsAppPairingObservationV1(read).flags.outcome).toBe('complete')
    })

    it('does not read the keys while the page is not synced', async () => {
        const getters = installPage({ hasSynced: false })
        const read = await readWhatsAppPairingObservationV1(clientWith(async (pageFunction) => pageFunction()), noTimers)
        expect(getters.getMaybeMePnUser).not.toHaveBeenCalled()
        expect(getters.getMaybeMeLidUser).not.toHaveBeenCalled()
        expect(classifyWhatsAppPairingObservationV1(read).flags.outcome).toBe('gated')
    })

    it('reports a missing WhatsApp Web module loader as unavailable', async () => {
        scope.require = undefined
        const read = await readWhatsAppPairingObservationV1(clientWith(async (pageFunction) => pageFunction()), noTimers)
        expect(classifyWhatsAppPairingObservationV1(read).flags).toMatchObject({ outcome: 'unavailable', reasonClass: 'module_unavailable' })
    })

    it('reports a missing or closed page as unavailable without evaluating', async () => {
        expect(await readWhatsAppPairingObservationV1({ pupPage: null }, noTimers)).toEqual({ kind: 'unavailable', reasonClass: 'page_missing' })
        const evaluate = vi.fn()
        expect(await readWhatsAppPairingObservationV1(clientWith(evaluate, { isClosed: () => true }), noTimers))
            .toEqual({ kind: 'unavailable', reasonClass: 'page_closed' })
        expect(evaluate).not.toHaveBeenCalled()
    })

    it('reports a destroyed execution context, other evaluate errors and malformed results as unavailable', async () => {
        const destroyed = clientWith(async () => { throw new Error('Execution context was destroyed, most likely because of a navigation.') })
        expect(await readWhatsAppPairingObservationV1(destroyed, noTimers)).toEqual({ kind: 'unavailable', reasonClass: 'context_destroyed' })
        const failed = clientWith(async () => { throw new Error('boom') })
        expect(await readWhatsAppPairingObservationV1(failed, noTimers)).toEqual({ kind: 'unavailable', reasonClass: 'evaluate_failed' })
        const malformed = clientWith(async () => '{}')
        expect(await readWhatsAppPairingObservationV1(malformed, noTimers)).toEqual({ kind: 'unavailable', reasonClass: 'malformed_result' })
    })

    it('times out a page evaluation that never settles and clears its timer', async () => {
        let fire: (() => void) | null = null
        const clearTimer = vi.fn()
        const pending = readWhatsAppPairingObservationV1(clientWith(() => new Promise(() => undefined)), {
            timeoutMs: 5_000,
            setTimer: (callback) => { fire = callback; return 'timer-1' },
            clearTimer,
        })
        expect(fire).not.toBeNull()
        fire!()
        expect(await pending).toEqual({ kind: 'timeout' })
        expect(clearTimer).toHaveBeenCalledWith('timer-1')
    })
})

interface Harness {
    deps: WhatsAppPairingObserverDependenciesV1
    emitted: Array<{ event: string; context: Readonly<Record<string, unknown>> }>
    deferred: Array<() => void>
    timers: Array<() => void>
    clock: { now: number }
    runDeferred(): Promise<void>
}

function harness(overrides: Partial<WhatsAppPairingObserverDependenciesV1> = {}): Harness {
    const emitted: Harness['emitted'] = []
    const deferred: Array<() => void> = []
    const timers: Array<() => void> = []
    const clock = { now: 1_000_000 }
    const deps: WhatsAppPairingObserverDependenciesV1 = {
        emit: (event, context) => { emitted.push({ event, context }) },
        now: () => clock.now,
        defer: (task) => { deferred.push(task) },
        setTimer: (callback) => { timers.push(callback); return timers.length },
        clearTimer: () => undefined,
        comparisonKey: new Uint8Array(32).fill(7),
        readTimeoutMs: 5_000,
        jobDeadlineMs: 15_000,
        slotIdleTtlMs: 60_000,
        maxTrackedSlots: 3,
        ...overrides,
    }
    return {
        deps,
        emitted,
        deferred,
        timers,
        clock,
        async runDeferred() {
            while (deferred.length) deferred.shift()!()
            for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
        },
    }
}

function completePage(pn = PN_USER, lid = LID_USER) {
    return {
        moduleAvailable: true,
        socketState: 'CONNECTED',
        hasSynced: true,
        pn: { server: 'c.us', user: pn, device: null, agent: null },
        pnReadFailed: false,
        lid: { server: 'lid', user: lid, device: null, agent: null },
        lidReadFailed: false,
        waWebVersion: WA_WEB_VERSION,
    }
}

function request(
    event: WhatsAppPairingObservationRequestV1['event'],
    overrides: Partial<WhatsAppPairingObservationRequestV1> = {},
): WhatsAppPairingObservationRequestV1 {
    return {
        event,
        connectionId: SLOT_ID,
        instanceId: 'instance-1',
        client: { pupPage: { evaluate: async () => completePage() }, info: { wid: { server: 'c.us', user: PN_USER } } },
        isCurrentInstance: () => true,
        ...overrides,
    }
}

function assertNoIdentifier(emitted: Harness['emitted']) {
    const text = JSON.stringify(emitted)
    for (const identifier of [PN_USER, LID_USER, OTHER_PN_USER, OTHER_LID_USER]) {
        expect(text).not.toContain(identifier)
    }
    expect(text).not.toMatch(/@(?:c\.us|lid|s\.whatsapp\.net)/)
    for (const { context } of emitted) {
        expect(Object.keys(context).every((key) => (WHATSAPP_PAIRING_TELEMETRY_FIELDS_V1 as readonly string[]).includes(key))).toBe(true)
    }
}

describe('createWhatsAppPairingObserverV1', () => {
    it('defers the ready read past the calling handler and never blocks it', async () => {
        const h = harness()
        const order: string[] = []
        const evaluate = vi.fn(() => new Promise<unknown>(() => undefined))
        const observer = createWhatsAppPairingObserverV1(h.deps)
        order.push('handler:start')
        observer.observe(request('ready', { client: { pupPage: { evaluate }, info: null } }))
        order.push('handler:continues')
        expect(evaluate).not.toHaveBeenCalled()
        expect(h.deferred).toHaveLength(1)
        await h.runDeferred()
        order.push('read:started')
        expect(order).toEqual(['handler:start', 'handler:continues', 'read:started'])
        expect(evaluate).toHaveBeenCalledTimes(1)
        expect(h.emitted).toEqual([])
        h.timers.shift()!()
        await h.runDeferred()
        expect(h.emitted).toHaveLength(1)
        expect(h.emitted[0].context).toMatchObject({ lifecycleEvent: 'ready', outcome: 'timeout' })
    })

    it('emits one complete observation per ready with no identifier in the payload', async () => {
        const h = harness()
        const observer = createWhatsAppPairingObserverV1(h.deps)
        observer.observe(request('ready'))
        await h.runDeferred()
        expect(h.emitted).toHaveLength(1)
        expect(h.emitted[0].event).toBe('wa_pairing_observation')
        expect(h.emitted[0].context).toEqual({
            connectionId: SLOT_ID,
            instanceOrdinal: 1,
            lifecycleEvent: 'ready',
            reasonClass: 'none',
            outcome: 'complete',
            readyCount: 1,
            coalescedReadyCount: 0,
            qrCount: 0,
            qrSeen: false,
            socketStateClass: 'connected',
            hasSynced: true,
            pnPresent: true,
            pnShapeValid: true,
            lidPresent: true,
            lidShapeValid: true,
            pnDiffersFromLid: true,
            infoWidMatchesPn: true,
            unchangedSincePreviousObservation: null,
            waWebVersion: WA_WEB_VERSION,
            durationMs: 0,
        })
        assertNoIdentifier(h.emitted)
    })

    it('measures repeated ready by counting, coalescing and comparing the pair in memory only', async () => {
        const h = harness()
        let resolveFirst: ((value: unknown) => void) | null = null
        let pair = { pn: PN_USER, lid: LID_USER }
        const evaluate = vi.fn()
            .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
            .mockImplementation(async () => completePage(pair.pn, pair.lid))
        const client = { pupPage: { evaluate }, info: { wid: { server: 'c.us', user: PN_USER } } }
        const observer = createWhatsAppPairingObserverV1(h.deps)

        observer.observe(request('ready', { client }))
        await h.runDeferred()
        observer.observe(request('ready', { client }))
        observer.observe(request('ready', { client }))
        expect(h.deferred).toHaveLength(0)
        resolveFirst!(completePage())
        await h.runDeferred()

        expect(evaluate).toHaveBeenCalledTimes(2)
        expect(h.emitted.map((entry) => entry.context)).toMatchObject([
            { outcome: 'complete', readyCount: 3, coalescedReadyCount: 0, unchangedSincePreviousObservation: null },
            { outcome: 'complete', readyCount: 3, coalescedReadyCount: 1, unchangedSincePreviousObservation: true },
        ])

        pair = { pn: OTHER_PN_USER, lid: OTHER_LID_USER }
        const changedClient = { pupPage: { evaluate }, info: { wid: { server: 'c.us', user: OTHER_PN_USER } } }
        observer.observe(request('ready', { client: changedClient }))
        await h.runDeferred()
        expect(h.emitted[2].context).toMatchObject({ outcome: 'complete', readyCount: 4, unchangedSincePreviousObservation: false })
        assertNoIdentifier(h.emitted)
    })

    it('never runs the full reader for QR refreshes and bounds their telemetry', async () => {
        const h = harness()
        const evaluate = vi.fn(async () => completePage())
        const client = { pupPage: { evaluate }, info: { wid: { server: 'c.us', user: PN_USER } } }
        const observer = createWhatsAppPairingObserverV1(h.deps)
        for (let refresh = 0; refresh < 50; refresh += 1) observer.observe(request('qr', { client }))
        await h.runDeferred()
        expect(evaluate).not.toHaveBeenCalled()
        expect(h.deferred).toHaveLength(0)
        expect(h.emitted).toHaveLength(1)
        expect(h.emitted[0].context).toMatchObject({ lifecycleEvent: 'qr', outcome: 'gated', qrCount: 1, qrSeen: true, pnPresent: null })

        observer.observe(request('ready', { client }))
        await h.runDeferred()
        expect(evaluate).toHaveBeenCalledTimes(1)
        expect(h.emitted[1].context).toMatchObject({ lifecycleEvent: 'ready', qrCount: 50, qrSeen: true, outcome: 'complete' })
    })

    it('records a disconnect as lifecycle telemetry only and drops a pending ready read', async () => {
        const h = harness()
        const evaluate = vi.fn(async () => completePage())
        const client = { pupPage: { evaluate }, info: { wid: { server: 'c.us', user: PN_USER } } }
        const observer = createWhatsAppPairingObserverV1(h.deps)
        observer.observe(request('ready', { client }))
        observer.observe(request('disconnected', { client, disconnectReason: 'LOGOUT' }))
        await h.runDeferred()
        expect(evaluate).not.toHaveBeenCalled()
        expect(h.emitted.map((entry) => entry.context)).toMatchObject([
            { lifecycleEvent: 'disconnected', reasonClass: 'logout', outcome: 'unavailable', readyCount: 1 },
        ])

        observer.observe(request('disconnected', { client, disconnectReason: 'NAVIGATION' }))
        observer.observe(request('disconnected', { client, disconnectReason: { unexpected: PN_USER } }))
        expect(h.emitted.slice(1).map((entry) => entry.context.reasonClass)).toEqual(['navigation', 'other_disconnect'])
        assertNoIdentifier(h.emitted)
    })

    it('reports a stale instance before and after the page read and keeps no pair from it', async () => {
        const h = harness()
        const evaluate = vi.fn(async () => completePage())
        const client = { pupPage: { evaluate }, info: { wid: { server: 'c.us', user: PN_USER } } }
        const observer = createWhatsAppPairingObserverV1(h.deps)

        observer.observe(request('ready', { client, isCurrentInstance: () => false }))
        await h.runDeferred()
        expect(evaluate).not.toHaveBeenCalled()
        expect(h.emitted[0].context).toMatchObject({ outcome: 'stale_instance', pnPresent: null })

        let current = true
        const flippingEvaluate = vi.fn(async () => {
            current = false
            return completePage()
        })
        observer.observe(request('ready', { client: { pupPage: { evaluate: flippingEvaluate }, info: client.info }, isCurrentInstance: () => current }))
        await h.runDeferred()
        expect(h.emitted[1].context).toMatchObject({ outcome: 'stale_instance', pnPresent: null })

        observer.observe(request('ready', { client }))
        await h.runDeferred()
        expect(h.emitted[2].context).toMatchObject({ outcome: 'complete', unchangedSincePreviousObservation: null })
    })

    it('reports a ready that waited past the deadline as a timeout without reading the page', async () => {
        const h = harness()
        const evaluate = vi.fn(async () => completePage())
        const observer = createWhatsAppPairingObserverV1(h.deps)
        observer.observe(request('ready', { client: { pupPage: { evaluate }, info: null } }))
        h.clock.now += 15_001
        await h.runDeferred()
        expect(evaluate).not.toHaveBeenCalled()
        expect(h.emitted[0].context).toMatchObject({ outcome: 'timeout', reasonClass: 'deadline_exceeded' })
    })

    it('resets per-instance counters and evicts idle and excess slot state', async () => {
        const h = harness()
        const observer = createWhatsAppPairingObserverV1(h.deps)
        observer.observe(request('qr'))
        observer.observe(request('ready'))
        await h.runDeferred()
        observer.observe(request('ready', { instanceId: 'instance-2' }))
        await h.runDeferred()
        expect(h.emitted.at(-1)!.context).toMatchObject({ instanceOrdinal: 2, readyCount: 1, qrCount: 0, qrSeen: false })
        expect(observer.trackedSlotCount()).toBe(1)

        observer.observe(request('qr', { connectionId: 'cslotpairingobservation0002' }))
        observer.observe(request('qr', { connectionId: 'cslotpairingobservation0003' }))
        observer.observe(request('qr', { connectionId: 'cslotpairingobservation0004' }))
        expect(observer.trackedSlotCount()).toBeLessThanOrEqual(3)

        h.clock.now += 60_001
        observer.observe(request('qr', { connectionId: 'cslotpairingobservation0005' }))
        expect(observer.trackedSlotCount()).toBe(1)
    })

    it('keeps a slot whose read is still running when idle slots are evicted', async () => {
        const h = harness({ maxTrackedSlots: 2 })
        const observer = createWhatsAppPairingObserverV1(h.deps)
        const hanging = { pupPage: { evaluate: () => new Promise<unknown>(() => undefined) }, info: null }
        observer.observe(request('ready', { client: hanging }))
        await h.runDeferred()
        h.clock.now += 60_001
        observer.observe(request('qr', { connectionId: 'cslotpairingobservation0002' }))
        observer.observe(request('qr', { connectionId: 'cslotpairingobservation0003' }))
        expect(observer.trackedSlotCount()).toBe(2)
        observer.observe(request('ready', { client: hanging }))
        expect(h.deferred).toHaveLength(0)
    })

    it('never throws into the handler when the instance check, emitter or telemetry contract fails', async () => {
        const failingEmitter = harness({ emit: () => { throw new Error('log sink down') } })
        const observer = createWhatsAppPairingObserverV1(failingEmitter.deps)
        expect(() => observer.observe(request('qr'))).not.toThrow()
        expect(() => observer.observe(request('ready', { isCurrentInstance: () => { throw new Error('boom') } }))).not.toThrow()
        await failingEmitter.runDeferred()

        const refused = harness()
        const refusingObserver = createWhatsAppPairingObserverV1(refused.deps)
        refusingObserver.observe(request('qr', { connectionId: PN_USER }))
        expect(refused.emitted).toEqual([{ event: 'wa_pairing_observation_telemetry_rejected', context: {} }])
    })
})

describe('buildWhatsAppPairingTelemetryV1', () => {
    const valid = (): WhatsAppPairingTelemetryInputV1 => ({
        connectionId: SLOT_ID,
        instanceOrdinal: 1,
        lifecycleEvent: 'ready',
        reasonClass: 'none',
        outcome: 'complete',
        readyCount: 1,
        coalescedReadyCount: 0,
        qrCount: 0,
        qrSeen: false,
        socketStateClass: 'connected',
        hasSynced: true,
        pnPresent: true,
        pnShapeValid: true,
        lidPresent: true,
        lidShapeValid: true,
        pnDiffersFromLid: true,
        infoWidMatchesPn: true,
        unchangedSincePreviousObservation: null,
        waWebVersion: WA_WEB_VERSION,
        durationMs: 12,
    })

    it('emits exactly the allowlisted fields', () => {
        expect(Object.keys(buildWhatsAppPairingTelemetryV1(valid())).sort()).toEqual([...WHATSAPP_PAIRING_TELEMETRY_FIELDS_V1].sort())
    })

    it.each([
        ['an identifier field', { pnUser: PN_USER }],
        ['a JID field', { jid: `${LID_USER}@lid` }],
        ['a digest field', { pairDigest: 'x2b7' }],
        ['a phone-shaped slot id', { connectionId: PN_USER }],
        ['a JID-shaped slot id', { connectionId: `${PN_USER}@c.us` }],
        ['an identifier in a boolean field', { pnPresent: PN_USER }],
        ['an identifier in an enum field', { reasonClass: LID_USER }],
        ['an identifier in a count field', { readyCount: Number(PN_USER) }],
        ['a truncated identifier in qrSeen', { qrSeen: PN_USER.slice(0, 4) }],
    ])('refuses %s', (_label, override) => {
        expect(() => buildWhatsAppPairingTelemetryV1({ ...valid(), ...(override as object) } as WhatsAppPairingTelemetryInputV1)).toThrow(TypeError)
    })

    it('refuses a payload with a missing field', () => {
        const input = valid() as Partial<WhatsAppPairingTelemetryInputV1>
        delete input.outcome
        expect(() => buildWhatsAppPairingTelemetryV1(input as WhatsAppPairingTelemetryInputV1)).toThrow(TypeError)
    })

    it('never logs a version string that is not version-shaped', () => {
        expect(buildWhatsAppPairingTelemetryV1({ ...valid(), waWebVersion: `${PN_USER}@c.us` }).waWebVersion).toBe('unrecognized')
        expect(buildWhatsAppPairingTelemetryV1({ ...valid(), waWebVersion: PN_USER }).waWebVersion).toBe('unrecognized')
    })
})
