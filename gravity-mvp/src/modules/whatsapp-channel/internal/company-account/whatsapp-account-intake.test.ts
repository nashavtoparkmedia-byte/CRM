/**
 * Intake and privacy tests.
 *
 * The intake must never affect the WhatsApp runtime, and no provider value may
 * leave this module through the operational log. The sentinel tests run a full
 * observation and assert the sentinels appear nowhere in what was emitted.
 */
import { describe, expect, it, vi } from 'vitest'

import { createWhatsAppAccountIntakeV1, type ObservedAttestationV1 } from './whatsapp-account-intake'
import {
    buildWhatsAppAccountTelemetryV1,
    WHATSAPP_ACCOUNT_TELEMETRY_EVENT_V1,
    WHATSAPP_ACCOUNT_TELEMETRY_FIELDS_V1,
    WHATSAPP_ACCOUNT_TELEMETRY_REJECTED_EVENT_V1,
} from './whatsapp-account-telemetry'
import type { AttestationResultV1 } from './whatsapp-account-writer'

const PN_SENTINEL = '70001112233'
const LID_SENTINEL = '199887766554433'

const RESULT: AttestationResultV1 = {
    action: 'open_first_generation',
    outcome: 'opened_first_generation',
    trustStateBefore: 'absent',
    trustStateAfter: 'pending',
    accountLifecycle: 'pending_approval',
    generation: 1,
    operatorConfirmed: false,
    signalAgreedWithDatabase: null,
}

function observed(overrides: Partial<ObservedAttestationV1> = {}): ObservedAttestationV1 {
    return { connectionId: 'connection-1', instanceId: 'instance-1', pnUser: PN_SENTINEL, lidUser: LID_SENTINEL, unchanged: null, ...overrides }
}

function harness(record: (input: ObservedAttestationV1) => Promise<AttestationResultV1>) {
    const emitted: Array<{ event: string; context: Readonly<Record<string, unknown>> }> = []
    let clock = 1000
    const intake = createWhatsAppAccountIntakeV1({
        record,
        emit: (event, context) => { emitted.push({ event, context }) },
        now: () => (clock += 5),
    })
    return { intake, emitted }
}

describe('intake', () => {
    it('emits one allowlisted payload for a recorded observation', async () => {
        const { intake, emitted } = harness(async () => RESULT)
        await intake.record(observed())
        expect(emitted).toHaveLength(1)
        expect(emitted[0].event).toBe(WHATSAPP_ACCOUNT_TELEMETRY_EVENT_V1)
        expect(Object.keys(emitted[0].context).sort()).toEqual([...WHATSAPP_ACCOUNT_TELEMETRY_FIELDS_V1].sort())
        expect(emitted[0].context).toMatchObject({ action: 'open_first_generation', accountLifecycle: 'pending_approval', generation: 1 })
    })

    it('never throws when the writer refuses, and says so with an empty rejection', async () => {
        const { intake, emitted } = harness(async () => { throw new Error('refused') })
        await expect(intake.record(observed())).resolves.toBeUndefined()
        expect(emitted).toEqual([{ event: WHATSAPP_ACCOUNT_TELEMETRY_REJECTED_EVENT_V1, context: {} }])
    })

    it('never throws when the writer returns something the contract refuses', async () => {
        const { intake, emitted } = harness(async () => ({ ...RESULT, action: 'not-an-action' } as unknown as AttestationResultV1))
        await expect(intake.record(observed())).resolves.toBeUndefined()
        expect(emitted).toEqual([{ event: WHATSAPP_ACCOUNT_TELEMETRY_REJECTED_EVENT_V1, context: {} }])
    })

    it('passes the runtime signal through as evidence without letting it change the call', async () => {
        const seen: Array<boolean | null> = []
        const { intake } = harness(async (input) => { seen.push(input.unchanged); return RESULT })
        for (const unchanged of [null, true, false]) await intake.record(observed({ unchanged }))
        expect(seen).toEqual([null, true, false])
    })
})

describe('no provider value escapes through the log', () => {
    it('emits neither sentinel for a recorded observation', async () => {
        const { intake, emitted } = harness(async () => RESULT)
        await intake.record(observed())
        const serialized = JSON.stringify(emitted)
        expect(serialized).not.toContain(PN_SENTINEL)
        expect(serialized).not.toContain(LID_SENTINEL)
    })

    it('emits neither sentinel when the writer refuses', async () => {
        const { intake, emitted } = harness(async () => { throw new Error(`refused for ${PN_SENTINEL} / ${LID_SENTINEL}`) })
        await intake.record(observed())
        const serialized = JSON.stringify(emitted)
        expect(serialized).not.toContain(PN_SENTINEL)
        expect(serialized).not.toContain(LID_SENTINEL)
    })

    it('emits neither sentinel when the telemetry contract itself refuses', async () => {
        const { intake, emitted } = harness(async () => ({ ...RESULT, outcome: PN_SENTINEL } as unknown as AttestationResultV1))
        await intake.record(observed())
        expect(JSON.stringify(emitted)).not.toContain(PN_SENTINEL)
    })

    it('does not write to the console', async () => {
        const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined))
        try {
            const { intake } = harness(async () => RESULT)
            await intake.record(observed())
            const failing = harness(async () => { throw new Error('refused') })
            await failing.intake.record(observed())
            for (const spy of spies) expect(spy).not.toHaveBeenCalled()
        } finally {
            spies.forEach((spy) => spy.mockRestore())
        }
    })
})

describe('telemetry contract', () => {
    const valid = {
        connectionId: 'connection-1',
        action: 'reattest_open_generation',
        outcome: 'reattested',
        trustStateBefore: 'pending',
        trustStateAfter: 'pending',
        accountLifecycle: 'pending_approval',
        generation: 2,
        operatorConfirmed: false,
        unchangedSignal: true,
        signalAgreedWithDatabase: true,
        durationMs: 12,
    } as const

    it('freezes a payload with exactly the allowlisted fields', () => {
        const payload = buildWhatsAppAccountTelemetryV1({ ...valid })
        expect(Object.isFrozen(payload)).toBe(true)
        expect(Object.keys(payload).sort()).toEqual([...WHATSAPP_ACCOUNT_TELEMETRY_FIELDS_V1].sort())
    })

    it('refuses an unknown field, so a provider value cannot be smuggled in', () => {
        expect(() => buildWhatsAppAccountTelemetryV1({ ...valid, pnUser: PN_SENTINEL } as never)).toThrow(/refused: pnUser/u)
    })

    it('refuses a missing field', () => {
        const { generation, ...withoutGeneration } = valid
        expect(() => buildWhatsAppAccountTelemetryV1(withoutGeneration as never)).toThrow(/refused: generation/u)
    })

    it('refuses values outside each field contract', () => {
        expect(() => buildWhatsAppAccountTelemetryV1({ ...valid, action: 'delete_everything' } as never)).toThrow(/refused: action/u)
        expect(() => buildWhatsAppAccountTelemetryV1({ ...valid, outcome: PN_SENTINEL } as never)).toThrow(/refused: outcome/u)
        expect(() => buildWhatsAppAccountTelemetryV1({ ...valid, trustStateAfter: 'super' } as never)).toThrow(/refused: trustStateAfter/u)
        expect(() => buildWhatsAppAccountTelemetryV1({ ...valid, accountLifecycle: 'whatever' } as never)).toThrow(/refused: accountLifecycle/u)
        expect(() => buildWhatsAppAccountTelemetryV1({ ...valid, connectionId: `${PN_SENTINEL}@c.us` } as never)).toThrow(/refused: connectionId/u)
        expect(() => buildWhatsAppAccountTelemetryV1({ ...valid, generation: -1 } as never)).toThrow(/refused: generation/u)
        expect(() => buildWhatsAppAccountTelemetryV1({ ...valid, unchangedSignal: 'maybe' } as never)).toThrow(/refused: unchangedSignal/u)
    })

    it('names no field after an identifier', () => {
        const identifier = /^(?:pn|lid|jid|wid|phone|number|user|value|key|pair)$|(?:User|Jid|Wid|Phone|Number|Value|Key|Pair)$/u
        for (const field of WHATSAPP_ACCOUNT_TELEMETRY_FIELDS_V1) expect(field).not.toMatch(identifier)
    })
})
