// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
    createMobilePushRegistrationHandlerV1,
    isEligibleMobilePushRegistrationV1,
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
        tokenIsBound: vi.fn(async () => true),
        revokeDevice: vi.fn(async () => 1),
        listEligible: vi.fn(async () => []),
        view: vi.fn(async () => null),
        currentToken: vi.fn(async () => null),
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
        const p = port({ bind, tokenIsBound: vi.fn(async () => false) })
        expect(await createMobilePushRegistrationHandlerV1(p).register(WRITE, FACTS)).toEqual({ ok: true, registrationId: 'reg_1', reclaimedStaleBinding: false })
        expect(bind).toHaveBeenCalledTimes(2)
    })

    it('gives up closed rather than looping when the token keeps changing hands', async () => {
        const p = port({ bind: vi.fn(async () => ({ outcome: 'token_conflict' as const })), tokenIsBound: vi.fn(async () => false) })
        expect(await createMobilePushRegistrationHandlerV1(p).register(WRITE, FACTS)).toEqual({ ok: false, code: 'PUSH_TOKEN_BOUND_TO_OTHER_DEVICE' })
        expect(p.bind).toHaveBeenCalledTimes(3)
    })

    it('decides eligibility on server facts only', () => {
        const live = { revoked: false, sessionExpiresAt: WRITE.sessionExpiresAt, sessionRevocationEpoch: '0', credentialSubject: 'mobile', credentialKeyId: '0123456789abcdef' }
        expect(isEligibleMobilePushRegistrationV1(live, FACTS)).toBe(true)
        expect(isEligibleMobilePushRegistrationV1({ ...live, revoked: true }, FACTS)).toBe(false)
        expect(isEligibleMobilePushRegistrationV1({ ...live, sessionExpiresAt: NOW }, FACTS)).toBe(false)
        expect(isEligibleMobilePushRegistrationV1({ ...live, sessionRevocationEpoch: '1' }, FACTS)).toBe(false)
        expect(isEligibleMobilePushRegistrationV1({ ...live, credentialSubject: 'other' }, FACTS)).toBe(false)
        expect(isEligibleMobilePushRegistrationV1({ ...live, credentialKeyId: 'ffffffffffffffff' }, FACTS)).toBe(false)
    })

    it('resolves a stale session binding as a skip, before any token is read', async () => {
        const currentToken = vi.fn(async () => 'must-not-be-read')
        const p = port({
            view: vi.fn(async () => ({ id: 'reg_1', hasToken: true, sessionBindingId: 'b'.repeat(64), sessionExpiresAt: WRITE.sessionExpiresAt, sessionRevocationEpoch: '0', credentialSubject: 'mobile', credentialKeyId: '0123456789abcdef', revoked: false })),
            currentToken,
        })
        expect(await createMobilePushRegistrationHandlerV1(p).resolveTarget('reg_1', 'a'.repeat(64), FACTS)).toEqual({ kind: 'skip', reason: 'stale_session' })
        expect(currentToken).not.toHaveBeenCalled()
    })
})
