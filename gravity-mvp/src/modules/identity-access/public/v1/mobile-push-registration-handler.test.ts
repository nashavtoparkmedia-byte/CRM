// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
    createMobilePushRegistrationHandlerV1,
    mobilePushSubjectEpochV1,
    type MobilePushEligibilityFactsV1,
    type MobilePushEmployeeLivenessV1,
    type MobilePushRegistrationPortV1,
    type MobilePushRegistrationWriteV1,
} from './mobile-push-registration-handler'

const NOW = new Date('2026-09-22T12:00:00.000Z')
const FACTS: MobilePushEligibilityFactsV1 = { now: NOW, revocationEpoch: '0', credentialSubjectPrefix: 'staff-v2:' }
const allLive: MobilePushEmployeeLivenessV1 = async () => ({ kind: 'read', live: () => true })
const WRITE: MobilePushRegistrationWriteV1 = {
    deviceId: 'device-1',
    fcmToken: 'handler-token_0123456789:ABCDEFGHIJ',
    credentialSubject: 'staff-v2:0',
    runtimeOperatorId: 'u1',
    sessionBindingId: 'a'.repeat(64),
    barrierEntry: `${'a'.repeat(64)}.1790000000`,
    sessionIssuedAt: new Date(NOW.getTime() - 3600_000),
    sessionExpiresAt: new Date(NOW.getTime() + 11 * 3600_000),
    sessionRevocationEpoch: '0',
    now: NOW,
}

function port(overrides: Partial<MobilePushRegistrationPortV1> = {}): MobilePushRegistrationPortV1 {
    return {
        bind: vi.fn(async () => ({ outcome: 'bound' as const, registrationId: 'reg_1' })),
        reclaimFromIneligibleHolderAndBind: vi.fn(async () => ({ outcome: 'holder_not_reclaimable' as const })),
        tokenIsBoundToOtherDevice: vi.fn(async () => true),
        revokeDevice: vi.fn(async () => 1),
        listEligible: vi.fn(async () => []),
        status: vi.fn(async () => null),
        sendableToken: vi.fn(async () => ({ sendable: false as const })),
        clearTokenIfCurrent: vi.fn(async () => true),
        revokeIfTokenCurrent: vi.fn(async () => true),
        ...overrides,
    }
}

describe('Mobile Push v1 registration rules', () => {
    it('binds directly when the token is free', async () => {
        const p = port()
        expect(await createMobilePushRegistrationHandlerV1(p, allLive).register(WRITE, FACTS)).toEqual({ ok: true, registrationId: 'reg_1', reclaimedStaleBinding: false })
        expect(p.reclaimFromIneligibleHolderAndBind).not.toHaveBeenCalled()
    })

    it('refuses the shared fallback device id without touching storage', async () => {
        const p = port()
        expect(await createMobilePushRegistrationHandlerV1(p, allLive).register({ ...WRITE, deviceId: 'ephemeral-device' }, FACTS))
            .toEqual({ ok: false, code: 'PUSH_DEVICE_ID_NOT_STABLE' })
        expect(p.bind).not.toHaveBeenCalled()
    })

    it('fails closed while another live device holds the token', async () => {
        const p = port({ bind: vi.fn(async () => ({ outcome: 'token_conflict' as const })) })
        expect(await createMobilePushRegistrationHandlerV1(p, allLive).register(WRITE, FACTS)).toEqual({ ok: false, code: 'PUSH_TOKEN_BOUND_TO_OTHER_DEVICE' })
    })

    it('reports an explicit reclaim when the holder was provably ineligible', async () => {
        const p = port({
            bind: vi.fn(async () => ({ outcome: 'token_conflict' as const })),
            reclaimFromIneligibleHolderAndBind: vi.fn(async () => ({ outcome: 'bound' as const, registrationId: 'reg_1' })),
        })
        expect(await createMobilePushRegistrationHandlerV1(p, allLive).register(WRITE, FACTS)).toEqual({ ok: true, registrationId: 'reg_1', reclaimedStaleBinding: true })
        expect(p.reclaimFromIneligibleHolderAndBind).toHaveBeenCalledWith(WRITE, FACTS)
    })

    it('binds again when the holder released the token concurrently', async () => {
        const bind = vi.fn()
            .mockResolvedValueOnce({ outcome: 'token_conflict' })
            .mockResolvedValueOnce({ outcome: 'bound', registrationId: 'reg_1' })
        const p = port({ bind, tokenIsBoundToOtherDevice: vi.fn(async () => false) })
        expect(await createMobilePushRegistrationHandlerV1(p, allLive).register(WRITE, FACTS)).toEqual({ ok: true, registrationId: 'reg_1', reclaimedStaleBinding: false })
        expect(bind).toHaveBeenCalledTimes(2)
    })

    it('asks only whether ANOTHER device holds the token, so its own concurrent bind is never a 409', async () => {
        const bind = vi.fn()
            .mockResolvedValueOnce({ outcome: 'token_conflict' })
            .mockResolvedValueOnce({ outcome: 'bound', registrationId: 'reg_1' })
        const tokenIsBoundToOtherDevice = vi.fn(async () => false)
        const p = port({ bind, tokenIsBoundToOtherDevice })
        expect(await createMobilePushRegistrationHandlerV1(p, allLive).register(WRITE, FACTS)).toEqual({ ok: true, registrationId: 'reg_1', reclaimedStaleBinding: false })
        expect(tokenIsBoundToOtherDevice).toHaveBeenCalledWith(WRITE.fcmToken, WRITE.deviceId)
    })

    it('refuses for good once this device has logged this session out', async () => {
        const p = port({ bind: vi.fn(async () => ({ outcome: 'session_revoked' as const })) })
        expect(await createMobilePushRegistrationHandlerV1(p, allLive).register(WRITE, FACTS)).toEqual({ ok: false, code: 'MOBILE_SESSION_REVOKED' })
        // The barrier is decided by the write itself; nothing else is attempted.
        expect(p.reclaimFromIneligibleHolderAndBind).not.toHaveBeenCalled()
        expect(p.bind).toHaveBeenCalledTimes(1)
    })

    it('refuses when the logout lands while a reclaim is in flight', async () => {
        const p = port({
            bind: vi.fn(async () => ({ outcome: 'token_conflict' as const })),
            reclaimFromIneligibleHolderAndBind: vi.fn(async () => ({ outcome: 'session_revoked' as const })),
        })
        expect(await createMobilePushRegistrationHandlerV1(p, allLive).register(WRITE, FACTS)).toEqual({ ok: false, code: 'MOBILE_SESSION_REVOKED' })
        expect(p.bind).toHaveBeenCalledTimes(1)
    })

    it('records the logged-out session on the device when revoking', async () => {
        const p = port()
        const session = {
            credentialSubject: 'staff-v2:0', runtimeOperatorId: 'u1',
            sessionIssuedAt: WRITE.sessionIssuedAt, sessionExpiresAt: WRITE.sessionExpiresAt, sessionRevocationEpoch: '0',
        }
        const barrier = { sessionBindingId: WRITE.sessionBindingId, entry: WRITE.barrierEntry }
        await createMobilePushRegistrationHandlerV1(p, allLive).revokeForLogout('device-1', barrier, session, NOW)
        expect(p.revokeDevice).toHaveBeenCalledWith('device-1', barrier, session, 'logout', NOW)
    })

    it('gives up closed rather than looping when the token keeps changing hands', async () => {
        const p = port({ bind: vi.fn(async () => ({ outcome: 'token_conflict' as const })), tokenIsBoundToOtherDevice: vi.fn(async () => false) })
        expect(await createMobilePushRegistrationHandlerV1(p, allLive).register(WRITE, FACTS)).toEqual({ ok: false, code: 'PUSH_TOKEN_BOUND_TO_OTHER_DEVICE' })
        expect(p.bind).toHaveBeenCalledTimes(3)
    })

    it('sends or awaits only on the one conditional read, and explains a skip in order: missing, revoked, stale session, ineligible', async () => {
        const status = { id: 'reg_1', sessionBindingId: 'a'.repeat(64), revoked: false }
        const cases: Array<[Partial<MobilePushRegistrationPortV1>, unknown]> = [
            [{ sendableToken: vi.fn(async () => ({ sendable: true as const, token: 'handler-token_0123456789:ABCDEFGHIJ', runtimeOperatorId: 'u1', credentialSubject: 'staff-v2:0' })) }, { kind: 'send', token: 'handler-token_0123456789:ABCDEFGHIJ' }],
            [{ sendableToken: vi.fn(async () => ({ sendable: true as const, token: null, runtimeOperatorId: 'u1', credentialSubject: 'staff-v2:0' })) }, { kind: 'await_token' }],
            [{ status: vi.fn(async () => null) }, { kind: 'skip', reason: 'not_found' }],
            [{ status: vi.fn(async () => ({ ...status, revoked: true })) }, { kind: 'skip', reason: 'revoked' }],
            [{ status: vi.fn(async () => ({ ...status, sessionBindingId: 'b'.repeat(64) })) }, { kind: 'skip', reason: 'stale_session' }],
            // Not sendable although the row looks fine now (e.g. a racing
            // re-registration): the decision stays a skip.
            [{ status: vi.fn(async () => status) }, { kind: 'skip', reason: 'ineligible' }],
        ]
        for (const [overrides, expected] of cases) {
            const p = port(overrides)
            expect(await createMobilePushRegistrationHandlerV1(p, allLive).resolveTarget('reg_1', 'a'.repeat(64), FACTS)).toEqual(expected)
            expect(p.sendableToken).toHaveBeenCalledWith('reg_1', 'a'.repeat(64), FACTS)
        }
    })
})

describe('push follows the employee (docs/design/mobile-personal-signin-v1.md §2.4)', () => {
    const row = (registrationId: string, runtimeOperatorId: string, credentialSubject: string) => ({
        registrationId, sessionBindingId: registrationId.padEnd(64, '0'), runtimeOperatorId, credentialSubject,
    })

    it('reads the credential epoch only from a v2 subject', () => {
        expect(mobilePushSubjectEpochV1('staff-v2:0', 'staff-v2:')).toBe(0)
        expect(mobilePushSubjectEpochV1('staff-v2:17', 'staff-v2:')).toBe(17)
        for (const subject of ['mobile-operator', 'staff-v2:', 'staff-v2:-1', 'staff-v2:01', 'staff-v2:1.5', 'staff-v2:x', 'staff-v2:99999999999', 'xstaff-v2:1']) {
            expect(mobilePushSubjectEpochV1(subject, 'staff-v2:'), subject).toBeNull()
        }
    })

    it('fan-out keeps only registrations whose employee credential still backs them', async () => {
        const liveness = vi.fn<MobilePushEmployeeLivenessV1>(async () => ({ kind: 'read', live: (userId, epoch) => userId === 'u1' && epoch === 0 }))
        const p = port({
            listEligible: vi.fn(async () => [
                row('reg_live', 'u1', 'staff-v2:0'),
                row('reg_reset', 'u1', 'staff-v2:1'),
                row('reg_disabled', 'u2', 'staff-v2:0'),
                row('reg_shared', 'u3', 'mobile-operator'),
                row('reg_bad', 'u3', 'staff-v2:x'),
            ]),
        })
        const eligible = await createMobilePushRegistrationHandlerV1(p, liveness).listEligible(FACTS)
        expect(eligible).toEqual([{ registrationId: 'reg_live', sessionBindingId: 'reg_live'.padEnd(64, '0') }])
        // The shared v1 subject and a malformed one never reach the liveness read.
        expect(liveness).toHaveBeenCalledWith([{ userId: 'u1', userEpoch: 0 }, { userId: 'u1', userEpoch: 1 }, { userId: 'u2', userEpoch: 0 }])
        // Nothing carries a token or a credential fact out of fan-out.
        expect(Object.keys(eligible[0]).sort()).toEqual(['registrationId', 'sessionBindingId'])
    })

    it('fan-out sends to nobody when the credential store cannot be read', async () => {
        const p = port({ listEligible: vi.fn(async () => [row('reg_live', 'u1', 'staff-v2:0')]) })
        expect(await createMobilePushRegistrationHandlerV1(p, async () => ({ kind: 'unverifiable' })).listEligible(FACTS)).toEqual([])
    })

    it('send time checks the employee again, even after fan-out passed', async () => {
        const sendable = { sendable: true as const, token: 'handler-token_0123456789:ABCDEFGHIJ', runtimeOperatorId: 'u1', credentialSubject: 'staff-v2:0' }
        let liveNow = true
        const liveness = vi.fn<MobilePushEmployeeLivenessV1>(async () => ({ kind: 'read', live: () => liveNow }))
        const p = port({ listEligible: vi.fn(async () => [row('reg_1', 'u1', 'staff-v2:0')]), sendableToken: vi.fn(async () => sendable) })
        const handler = createMobilePushRegistrationHandlerV1(p, liveness)
        expect(await handler.listEligible(FACTS)).toHaveLength(1)
        // The employee is disabled (or reset, or logged out in the browser) between fan-out and send.
        liveNow = false
        expect(await handler.resolveTarget('reg_1', 'a'.repeat(64), FACTS)).toEqual({ kind: 'skip', reason: 'ineligible' })
        expect(liveness).toHaveBeenLastCalledWith([{ userId: 'u1', userEpoch: 0 }])
        liveNow = true
        expect(await handler.resolveTarget('reg_1', 'a'.repeat(64), FACTS)).toEqual({ kind: 'send', token: sendable.token })
    })

    it('send time skips, never sends, when the store cannot be read or the subject is not v2', async () => {
        const sendable = { sendable: true as const, token: 'handler-token_0123456789:ABCDEFGHIJ', runtimeOperatorId: 'u1', credentialSubject: 'staff-v2:0' }
        const unreadable = createMobilePushRegistrationHandlerV1(port({ sendableToken: vi.fn(async () => sendable) }), async () => ({ kind: 'unverifiable' }))
        expect(await unreadable.resolveTarget('reg_1', 'a'.repeat(64), FACTS)).toEqual({ kind: 'skip', reason: 'ineligible' })
        const shared = createMobilePushRegistrationHandlerV1(port({ sendableToken: vi.fn(async () => ({ ...sendable, credentialSubject: 'mobile-operator' })) }), allLive)
        expect(await shared.resolveTarget('reg_1', 'a'.repeat(64), FACTS)).toEqual({ kind: 'skip', reason: 'ineligible' })
    })
})
