/**
 * M2A2-TG2A intake proof: two orchestration modes over one writer.
 *
 * The runtime mode must be unable to fail into Telegram; the ceremony mode must
 * report exactly what it proved and must never claim a pending account it did
 * not observe.
 */
import { describe, expect, it, vi } from 'vitest'

// The exported entry points build their own dependencies from the writer, which
// imports the Prisma client at module load. The client is stubbed so no test can
// reach any database, including by accident through the process-wide singleton.
vi.mock('@/lib/prisma', () => ({
    prisma: {
        $transaction: async () => { throw new Error('database is not available in this test') },
    },
}))

import {
    attestTelegramTransportV1,
    createTelegramAccountIntakeV1,
    recordObservedAttestationV1,
    TELEGRAM_ACCOUNT_TELEMETRY_EVENT_V1,
    TELEGRAM_ACCOUNT_TELEMETRY_REJECTED_EVENT_V1,
    type AccountIntakeDependenciesV1,
    type ObservedAttestationV1,
} from './telegram-account-intake'

const observed: ObservedAttestationV1 = {
    transportKind: 'mtproto_session',
    transportRef: 'conn-row-1',
    accountKind: 'mtproto_user',
    providerUserId: '7000',
    attestingInstanceId: 'instance:conn-row-1',
}

const attestation = {
    action: 'open_first_generation' as const,
    outcome: 'opened_first_generation' as const,
    accountLifecycle: 'pending_approval',
    trustStateAfter: 'verified',
    generation: 1,
    principalChanged: false,
}

const projection = {
    channel: 'telegram' as const,
    providerAccountId: 'account-1',
    accountKind: 'mtproto_user' as const,
    lifecycle: 'pending_approval',
    readiness: 'not_admitted' as const,
    capabilities: [] as readonly string[],
}

// Every mock is declared with the dependency's own signature, so a drifting
// contract fails type checking here rather than silently in a cast.
const recordFn = (implementation: AccountIntakeDependenciesV1['record']) => vi.fn(implementation)
const projectFn = (implementation: AccountIntakeDependenciesV1['project']) => vi.fn(implementation)
const admitFn = (implementation: AccountIntakeDependenciesV1['admit']) => vi.fn(implementation)

function deps(overrides: Partial<AccountIntakeDependenciesV1> = {}) {
    const emitted: Array<{ level: string; event: string; context: Record<string, unknown> }> = []
    const base: AccountIntakeDependenciesV1 = {
        record: recordFn(async () => attestation),
        project: projectFn(async () => projection),
        admit: admitFn(async () => ({ outcome: 'admitted', lifecycle: 'active' })),
        emit: (level, event, context) => { emitted.push({ level, event, context: context as Record<string, unknown> }) },
        now: () => 0,
        ...overrides,
    }
    return { base, emitted }
}

describe('runtime observation is fire-and-forget', () => {
    it('records the live observation and reports it once', async () => {
        const { base, emitted } = deps()
        await createTelegramAccountIntakeV1(base).observe(observed)
        expect(base.record).toHaveBeenCalledTimes(1)
        expect(base.record).toHaveBeenCalledWith(observed)
        expect(emitted.map(entry => entry.event)).toEqual([TELEGRAM_ACCOUNT_TELEMETRY_EVENT_V1])
    })

    it('never reports a database failure to the caller', async () => {
        const { base, emitted } = deps({ record: recordFn(async () => { throw new Error('connection refused') }) })
        await expect(createTelegramAccountIntakeV1(base).observe(observed)).resolves.toBeUndefined()
        expect(emitted.map(entry => entry.event)).toEqual([TELEGRAM_ACCOUNT_TELEMETRY_REJECTED_EVENT_V1])
    })

    it('never reports a missing foundation table to the caller', async () => {
        const missing = Object.assign(new Error('The table `TelegramAccount` does not exist'), { code: 'P2021' })
        const { base } = deps({ record: recordFn(async () => { throw missing }) })
        await expect(createTelegramAccountIntakeV1(base).observe(observed)).resolves.toBeUndefined()
    })

    it('survives a telemetry sink that throws', async () => {
        const { base } = deps({
            record: recordFn(async () => { throw new Error('down') }),
            emit: () => { throw new Error('sink down') },
        })
        await expect(createTelegramAccountIntakeV1(base).observe(observed)).resolves.toBeUndefined()
    })

    it('returns synchronously and swallows everything through the exported entry point', () => {
        expect(recordObservedAttestationV1(observed)).toBeUndefined()
    })

    it('reports no principal, locator or process identity', async () => {
        const { base, emitted } = deps()
        await createTelegramAccountIntakeV1(base).observe(observed)
        const serialized = JSON.stringify(emitted)
        for (const forbidden of [observed.providerUserId, observed.transportRef, observed.attestingInstanceId]) {
            expect(serialized).not.toContain(forbidden)
        }
    })
})

describe('admission is synchronous and proves what it reports', () => {
    it('admits after attesting and reading the projection back, in that order', async () => {
        const order: string[] = []
        const { base } = deps({
            record: recordFn(async () => { order.push('record'); return attestation }),
            project: projectFn(async () => { order.push('project'); return projection }),
            admit: admitFn(async () => { order.push('admit'); return { outcome: 'admitted', lifecycle: 'active' } }),
        })
        const result = await createTelegramAccountIntakeV1(base).admit(observed, 'identity-access:integration-admin-session')
        expect(result).toEqual({ status: 'admitted', reason: 'admitted' })
        expect(order).toEqual(['record', 'project', 'admit'])
        expect(base.admit).toHaveBeenCalledWith({ accountId: 'account-1', principalId: 'identity-access:integration-admin-session' })
    })

    it('treats an already active account as admitted', async () => {
        const { base } = deps({ admit: admitFn(async () => ({ outcome: 'already_active', lifecycle: 'active' })) })
        await expect(createTelegramAccountIntakeV1(base).admit(observed, 'admin')).resolves.toEqual({
            status: 'admitted', reason: 'already_active',
        })
    })

    it('reports unavailable and admits nothing when the attestation cannot commit', async () => {
        const { base } = deps({ record: recordFn(async () => { throw new Error('connection refused') }) })
        const result = await createTelegramAccountIntakeV1(base).admit(observed, 'admin')
        expect(result).toEqual({ status: 'unavailable', reason: 'attestation_unavailable' })
        expect(base.project).not.toHaveBeenCalled()
        expect(base.admit).not.toHaveBeenCalled()
    })

    it('distinguishes a writer refusal from an unavailable foundation', async () => {
        const refusal = Object.assign(new Error('refused'), { name: 'TelegramAccountRefusalV1' })
        const { base } = deps({ record: recordFn(async () => { throw refusal }) })
        await expect(createTelegramAccountIntakeV1(base).admit(observed, 'admin')).resolves.toEqual({
            status: 'unavailable', reason: 'attestation_refused',
        })
    })

    it('refuses to admit when the attestation did not leave the binding verified', async () => {
        const { base } = deps({ record: recordFn(async () => ({ ...attestation, trustStateAfter: 'mismatched' })) })
        const result = await createTelegramAccountIntakeV1(base).admit(observed, 'admin')
        expect(result).toEqual({ status: 'unavailable', reason: 'attestation_refused' })
        expect(base.admit).not.toHaveBeenCalled()
    })

    it('reports unavailable when the projection cannot be read', async () => {
        const { base } = deps({ project: projectFn(async () => { throw new Error('down') }) })
        const result = await createTelegramAccountIntakeV1(base).admit(observed, 'admin')
        expect(result).toEqual({ status: 'unavailable', reason: 'projection_unavailable' })
        expect(base.admit).not.toHaveBeenCalled()
    })

    it('never fakes pending when no durable account exists', async () => {
        const { base } = deps({ project: projectFn(async () => ({ ...projection, providerAccountId: null, lifecycle: null })) })
        const result = await createTelegramAccountIntakeV1(base).admit(observed, 'admin')
        expect(result).toEqual({ status: 'unavailable', reason: 'account_absent' })
        expect(base.admit).not.toHaveBeenCalled()
    })

    it('refuses an account of another kind', async () => {
        const { base } = deps({ project: projectFn(async () => ({ ...projection, accountKind: 'bot_api' as const })) })
        await expect(createTelegramAccountIntakeV1(base).admit(observed, 'admin')).resolves.toEqual({
            status: 'unavailable', reason: 'account_absent',
        })
    })

    it('reports pending when a durable pending account exists and admission fails', async () => {
        const { base } = deps({ admit: admitFn(async () => { throw new Error('admission down') }) })
        await expect(createTelegramAccountIntakeV1(base).admit(observed, 'admin')).resolves.toEqual({
            status: 'pending_approval', reason: 'admission_unavailable',
        })
    })

    it('reports pending when the account is proven pending but not admissible right now', async () => {
        const { base } = deps({ admit: admitFn(async () => ({ outcome: 'not_admissible', lifecycle: 'pending_approval' })) })
        await expect(createTelegramAccountIntakeV1(base).admit(observed, 'admin')).resolves.toEqual({
            status: 'pending_approval', reason: 'admission_unavailable',
        })
    })

    it('does not report pending for a lifecycle that is not pending approval', async () => {
        const { base } = deps({
            project: projectFn(async () => ({ ...projection, lifecycle: 'retired' })),
            admit: admitFn(async () => ({ outcome: 'not_admissible', lifecycle: 'retired' })),
        })
        await expect(createTelegramAccountIntakeV1(base).admit(observed, 'admin')).resolves.toEqual({
            status: 'unavailable', reason: 'lifecycle_not_admissible',
        })
    })

    it('reports unavailable when the account vanished between the read and the admission', async () => {
        const { base } = deps({ admit: admitFn(async () => ({ outcome: 'account_not_found', lifecycle: 'unknown' })) })
        await expect(createTelegramAccountIntakeV1(base).admit(observed, 'admin')).resolves.toEqual({
            status: 'unavailable', reason: 'account_absent',
        })
    })

    it('fails closed when a second live observation disagrees with the first', async () => {
        const { base } = deps()
        const result = await createTelegramAccountIntakeV1(base).admit(
            { ...observed, previouslyObservedProviderUserId: '7001' },
            'admin',
        )
        expect(result).toEqual({ status: 'unavailable', reason: 'principal_observation_disagreed' })
        expect(base.record).not.toHaveBeenCalled()
        expect(base.project).not.toHaveBeenCalled()
        expect(base.admit).not.toHaveBeenCalled()
    })

    it('accepts two agreeing observations', async () => {
        const { base } = deps()
        await expect(createTelegramAccountIntakeV1(base).admit(
            { ...observed, previouslyObservedProviderUserId: observed.providerUserId },
            'admin',
        )).resolves.toEqual({ status: 'admitted', reason: 'admitted' })
        expect(base.record).toHaveBeenCalledTimes(1)
    })

    it('hands the writer the locator it was given and nothing else', async () => {
        const { base } = deps()
        await createTelegramAccountIntakeV1(base).admit(
            { ...observed, previouslyObservedProviderUserId: observed.providerUserId },
            'admin',
        )
        expect(base.record).toHaveBeenCalledWith(observed)
        const passed = (base.record as unknown as { mock: { calls: Array<Array<Record<string, unknown>>> } }).mock.calls[0][0]
        expect(Object.keys(passed).sort()).toEqual([
            'accountKind', 'attestingInstanceId', 'providerUserId', 'transportKind', 'transportRef',
        ])
    })
})

describe('the ingress mode is awaited and never admits', () => {
    it('returns the writer outcome to its caller', async () => {
        const { base } = deps()
        const result = await createTelegramAccountIntakeV1(base).attestTransport(observed)
        expect(result).toEqual(attestation)
        expect(base.record).toHaveBeenCalledWith(observed)
    })

    it('never admits and never reads the projection', async () => {
        const { base } = deps()
        await createTelegramAccountIntakeV1(base).attestTransport(observed)
        expect(base.admit).not.toHaveBeenCalled()
        expect(base.project).not.toHaveBeenCalled()
    })

    it('reports its own mode in telemetry', async () => {
        const { base, emitted } = deps()
        await createTelegramAccountIntakeV1(base).attestTransport(observed)
        expect(emitted).toHaveLength(1)
        expect(emitted[0].context.mode).toBe('ingress')
    })

    it('surfaces a failure rather than swallowing it', async () => {
        const { base } = deps({ record: recordFn(async () => { throw new Error('down') }) })
        await expect(createTelegramAccountIntakeV1(base).attestTransport(observed)).rejects.toThrow('down')
    })

    it('maps a failure to a bounded outcome through the exported entry point', async () => {
        await expect(attestTelegramTransportV1(observed)).resolves.toEqual({
            recorded: false, outcome: 'attestation_unavailable',
        })
    })
})

describe('the display read can never admit', () => {
    it('describes an available account without writing anything', async () => {
        const { base } = deps()
        const state = await createTelegramAccountIntakeV1(base).describe('mtproto_session', 'conn-row-1')
        expect(state).toEqual({
            available: true,
            providerAccountId: 'account-1',
            accountKind: 'mtproto_user',
            lifecycle: 'pending_approval',
            readiness: 'not_admitted',
        })
        expect(base.record).not.toHaveBeenCalled()
        expect(base.admit).not.toHaveBeenCalled()
    })

    it('reports unavailable instead of throwing when the foundation is down', async () => {
        const { base } = deps({ project: projectFn(async () => { throw new Error('down') }) })
        await expect(createTelegramAccountIntakeV1(base).describe('mtproto_session', 'conn-row-1')).resolves.toEqual({
            available: false, providerAccountId: null, accountKind: null, lifecycle: null, readiness: null,
        })
    })
})
