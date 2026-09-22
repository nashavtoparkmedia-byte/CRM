// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
    createMobilePushRegistrationHandlerV1,
    type MobilePushEligibilityFactsV1,
    type MobilePushRegistrationPortV1,
    type MobilePushRegistrationWriteV1,
} from './mobile-push-registration-handler'

const NOW = new Date('2026-09-22T12:00:00.000Z')
const FACTS: MobilePushEligibilityFactsV1 = { now: NOW, revocationEpoch: '0', credentialSubject: 'mobile', credentialKeyId: '0123456789abcdef' }
const WRITE: MobilePushRegistrationWriteV1 = {
    deviceId: 'device-1',
    fcmToken: 'handler-token_0123456789:ABCDEFGHIJ',
    credentialSubject: 'mobile',
    runtimeOperatorId: 'u1',
    sessionBindingId: 'a'.repeat(64),
    sessionIssuedAt: new Date(NOW.getTime() - 3600_000),
    sessionExpiresAt: new Date(NOW.getTime() + 11 * 3600_000),
    sessionRevocationEpoch: '0',
    credentialKeyId: '0123456789abcdef',
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
        expect(await createMobilePushRegistrationHandlerV1(p).register(WRITE, FACTS)).toEqual({ ok: true, registrationId: 'reg_1', reclaimedStaleBinding: false })
        expect(p.reclaimFromIneligibleHolderAndBind).not.toHaveBeenCalled()
    })

    it('refuses the shared fallback device id without touching storage', async () => {
        const p = port()
        expect(await createMobilePushRegistrationHandlerV1(p).register({ ...WRITE, deviceId: 'ephemeral-device' }, FACTS))
            .toEqual({ ok: false, code: 'PUSH_DEVICE_ID_NOT_STABLE' })
        expect(p.bind).not.toHaveBeenCalled()
    })

    it('fails closed while another live device holds the token', async () => {
        const p = port({ bind: vi.fn(async () => ({ outcome: 'token_conflict' as const })) })
        expect(await createMobilePushRegistrationHandlerV1(p).register(WRITE, FACTS)).toEqual({ ok: false, code: 'PUSH_TOKEN_BOUND_TO_OTHER_DEVICE' })
    })

    it('reports an explicit reclaim when the holder was provably ineligible', async () => {
        const p = port({
            bind: vi.fn(async () => ({ outcome: 'token_conflict' as const })),
            reclaimFromIneligibleHolderAndBind: vi.fn(async () => ({ outcome: 'bound' as const, registrationId: 'reg_1' })),
        })
        expect(await createMobilePushRegistrationHandlerV1(p).register(WRITE, FACTS)).toEqual({ ok: true, registrationId: 'reg_1', reclaimedStaleBinding: true })
        expect(p.reclaimFromIneligibleHolderAndBind).toHaveBeenCalledWith(WRITE, FACTS)
    })

    it('binds again when the holder released the token concurrently', async () => {
        const bind = vi.fn()
            .mockResolvedValueOnce({ outcome: 'token_conflict' })
            .mockResolvedValueOnce({ outcome: 'bound', registrationId: 'reg_1' })
        const p = port({ bind, tokenIsBoundToOtherDevice: vi.fn(async () => false) })
        expect(await createMobilePushRegistrationHandlerV1(p).register(WRITE, FACTS)).toEqual({ ok: true, registrationId: 'reg_1', reclaimedStaleBinding: false })
        expect(bind).toHaveBeenCalledTimes(2)
    })

    it('asks only whether ANOTHER device holds the token, so its own concurrent bind is never a 409', async () => {
        const bind = vi.fn()
            .mockResolvedValueOnce({ outcome: 'token_conflict' })
            .mockResolvedValueOnce({ outcome: 'bound', registrationId: 'reg_1' })
        const tokenIsBoundToOtherDevice = vi.fn(async () => false)
        const p = port({ bind, tokenIsBoundToOtherDevice })
        expect(await createMobilePushRegistrationHandlerV1(p).register(WRITE, FACTS)).toEqual({ ok: true, registrationId: 'reg_1', reclaimedStaleBinding: false })
        expect(tokenIsBoundToOtherDevice).toHaveBeenCalledWith(WRITE.fcmToken, WRITE.deviceId)
    })

    it('gives up closed rather than looping when the token keeps changing hands', async () => {
        const p = port({ bind: vi.fn(async () => ({ outcome: 'token_conflict' as const })), tokenIsBoundToOtherDevice: vi.fn(async () => false) })
        expect(await createMobilePushRegistrationHandlerV1(p).register(WRITE, FACTS)).toEqual({ ok: false, code: 'PUSH_TOKEN_BOUND_TO_OTHER_DEVICE' })
        expect(p.bind).toHaveBeenCalledTimes(3)
    })

    it('sends or awaits only on the one conditional read, and explains a skip in order: missing, revoked, stale session, ineligible', async () => {
        const status = { id: 'reg_1', sessionBindingId: 'a'.repeat(64), revoked: false }
        const cases: Array<[Partial<MobilePushRegistrationPortV1>, unknown]> = [
            [{ sendableToken: vi.fn(async () => ({ sendable: true as const, token: 'handler-token_0123456789:ABCDEFGHIJ' })) }, { kind: 'send', token: 'handler-token_0123456789:ABCDEFGHIJ' }],
            [{ sendableToken: vi.fn(async () => ({ sendable: true as const, token: null })) }, { kind: 'await_token' }],
            [{ status: vi.fn(async () => null) }, { kind: 'skip', reason: 'not_found' }],
            [{ status: vi.fn(async () => ({ ...status, revoked: true })) }, { kind: 'skip', reason: 'revoked' }],
            [{ status: vi.fn(async () => ({ ...status, sessionBindingId: 'b'.repeat(64) })) }, { kind: 'skip', reason: 'stale_session' }],
            // Not sendable although the row looks fine now (e.g. a racing
            // re-registration): the decision stays a skip.
            [{ status: vi.fn(async () => status) }, { kind: 'skip', reason: 'ineligible' }],
        ]
        for (const [overrides, expected] of cases) {
            const p = port(overrides)
            expect(await createMobilePushRegistrationHandlerV1(p).resolveTarget('reg_1', 'a'.repeat(64), FACTS)).toEqual(expected)
            expect(p.sendableToken).toHaveBeenCalledWith('reg_1', 'a'.repeat(64), FACTS)
        }
    })
})
