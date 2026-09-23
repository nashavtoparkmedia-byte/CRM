import { describe, expect, it } from 'vitest'

import {
    ATTESTATION_REFRESH_FLOOR_MS_V1,
    ATTESTATION_WINDOW_MS_V1,
    attestationWindowUntilV1,
    decideTelegramTransportAttestationV1,
    deriveReadinessV1,
    isExactProviderUserIdV1,
    isUsablePrincipalV1,
    openTransportKeyV1,
    type OpenBindingSnapshotV1,
} from './telegram-account-identity'

const MTPROTO = { providerUserId: '1234567890', accountKind: 'mtproto_user' } as const
const BOT = { providerUserId: '7777777777', accountKind: 'bot_api' } as const
const OTHER_USER = { providerUserId: '2222222222', accountKind: 'mtproto_user' } as const
const NOW = 1_800_000_000_000

function openBinding(overrides: Partial<OpenBindingSnapshotV1> = {}): OpenBindingSnapshotV1 {
    return {
        bindingId: 'binding-1',
        accountId: 'account-1',
        accountProviderUserId: MTPROTO.providerUserId,
        accountKind: 'mtproto_user',
        trustState: 'verified',
        attestedProviderUserId: MTPROTO.providerUserId,
        attestedUntilMs: NOW + ATTESTATION_WINDOW_MS_V1,
        transportGeneration: 1,
        ...overrides,
    }
}

function decide(input: Partial<Parameters<typeof decideTelegramTransportAttestationV1>[0]> = {}) {
    return decideTelegramTransportAttestationV1({
        observed: MTPROTO,
        transportKind: 'mtproto_session',
        openBinding: null,
        dbNowMs: NOW,
        ...input,
    })
}

describe('provider identity is the getMe id and nothing else', () => {
    it('accepts an id only in exact provider form', () => {
        expect(isExactProviderUserIdV1('1234567890')).toBe(true)
        expect(isExactProviderUserIdV1('0')).toBe(true)
        for (const bad of ['+1234567890', ' 1234567890', '12a', '', '1234567890\n', null, 12345]) {
            expect(isExactProviderUserIdV1(bad)).toBe(false)
        }
    })

    it('refuses a principal without a usable kind', () => {
        expect(isUsablePrincipalV1(MTPROTO)).toBe(true)
        expect(isUsablePrincipalV1(BOT)).toBe(true)
        expect(isUsablePrincipalV1({ providerUserId: '1', accountKind: 'channel' })).toBe(false)
        expect(isUsablePrincipalV1(null)).toBe(false)
    })

    it('never derives an account from anything but the id and kind', () => {
        // A phone number, a display name or a session row id shaped like an id
        // is still not an id: only the digits the provider returned qualify.
        expect(isExactProviderUserIdV1('+79995551122')).toBe(false)
        expect(isExactProviderUserIdV1('cmf1x2y3z0000abcd')).toBe(false)
    })

    it('builds the open-transport key from kind and locator', () => {
        expect(openTransportKeyV1('mtproto_session', 'conn-A')).toBe('mtproto_session:conn-A')
        expect(openTransportKeyV1('bot_runtime', 'driver-bot-primary')).toBe('bot_runtime:driver-bot-primary')
    })
})

describe('decision table', () => {
    it('first attestation opens the first generation', () => {
        expect(decide()).toMatchObject({ action: 'open_first_generation', outcome: 'opened_first_generation', closeReason: null })
    })

    it('a repeated attestation inside a live window writes nothing', () => {
        expect(decide({ openBinding: openBinding() })).toMatchObject({ action: 'none', outcome: 'attestation_still_fresh' })
    })

    it('re-attests once the window falls below the refresh floor', () => {
        const snapshot = openBinding({ attestedUntilMs: NOW + ATTESTATION_REFRESH_FLOOR_MS_V1 - 1 })
        expect(decide({ openBinding: snapshot })).toMatchObject({ action: 'reattest_open_generation', outcome: 'reattested' })
    })

    it('re-attests the same principal after a process restart', () => {
        const snapshot = openBinding({ attestedUntilMs: NOW + 1 })
        expect(decide({ openBinding: snapshot })).toMatchObject({ action: 'reattest_open_generation' })
    })

    it('revives a verified binding whose window lapsed', () => {
        const snapshot = openBinding({ trustState: 'verified', attestedUntilMs: NOW - 1 })
        expect(decide({ openBinding: snapshot })).toMatchObject({ action: 'reattest_open_generation', outcome: 'reattested' })
    })

    it('revives a lapsed pending generation by re-attesting it, never by superseding', () => {
        // Unlike WhatsApp, the provider authentication is itself the proof, so
        // no state exists that a fresh attestation cannot restore. Only a
        // changed principal opens a new generation.
        const snapshot = openBinding({ trustState: 'pending', attestedUntilMs: NOW - 1 })
        expect(decide({ openBinding: snapshot }))
            .toMatchObject({ action: 'reattest_open_generation', outcome: 'reattested', closeReason: null })
    })

    it('opens a new generation only when the principal changes', () => {
        const lapsed = openBinding({ attestedUntilMs: NOW - 1 })
        expect(decide({ openBinding: lapsed }).closeReason).toBeNull()
        expect(decide({ observed: OTHER_USER, openBinding: lapsed }).closeReason).toBe('principal_changed')
    })

    it('replaces the generation when the authenticated principal differs', () => {
        expect(decide({ observed: OTHER_USER, openBinding: openBinding() }))
            .toMatchObject({ action: 'replace_on_principal_change', outcome: 'replaced_on_principal_change', closeReason: 'principal_changed' })
    })

    it('treats the same id under a different kind as a different principal', () => {
        const snapshot = openBinding({ accountKind: 'bot_api', accountProviderUserId: MTPROTO.providerUserId })
        expect(decide({ observed: MTPROTO, openBinding: snapshot }).action).toBe('replace_on_principal_change')
    })

    it('writes nothing when the principal is not usable', () => {
        expect(decide({ observed: null, openBinding: openBinding() }))
            .toMatchObject({ action: 'none', outcome: 'principal_not_usable' })
    })

    it('refuses a principal carried on the wrong transport kind', () => {
        expect(decide({ observed: BOT, transportKind: 'mtproto_session' }))
            .toMatchObject({ action: 'refuse', outcome: 'transport_kind_mismatch' })
        expect(decide({ observed: MTPROTO, transportKind: 'bot_runtime' }))
            .toMatchObject({ action: 'refuse', outcome: 'transport_kind_mismatch' })
    })

    it('opens a bot generation on a bot runtime', () => {
        expect(decide({ observed: BOT, transportKind: 'bot_runtime' }).action).toBe('open_first_generation')
    })

    it('replacing the transport for the same principal keeps the account', () => {
        // A recreated session is a fresh transport with no open binding: the
        // decision opens a generation, and account resolution then keys on the
        // unchanged provider id, so the same account is reused.
        expect(decide({ openBinding: null, observed: MTPROTO }).action).toBe('open_first_generation')
    })
})

describe('attestation window', () => {
    it('stays inside the one hour ceiling the database enforces', () => {
        const until = attestationWindowUntilV1(NOW)
        expect(until.getTime()).toBeGreaterThan(NOW)
        expect(until.getTime() - NOW).toBeLessThan(60 * 60 * 1000)
    })

    it('leaves room for clock skew between this process and the database', () => {
        expect(60 * 60 * 1000 - ATTESTATION_WINDOW_MS_V1).toBeGreaterThanOrEqual(10 * 60 * 1000)
    })
})

describe('readiness is derived, and separate from lifecycle', () => {
    const fresh = { trustState: 'verified', attestedUntilMs: NOW + 1000 }

    it('is ready only when admitted and currently attested', () => {
        expect(deriveReadinessV1({ lifecycle: 'active', openBinding: fresh, dbNowMs: NOW })).toBe('ready')
    })

    it('reports a healthy but stale account as stale, not unready', () => {
        expect(deriveReadinessV1({ lifecycle: 'active', openBinding: { trustState: 'verified', attestedUntilMs: NOW - 1 }, dbNowMs: NOW }))
            .toBe('stale_attestation')
    })

    it('reports an admitted account with no transport separately', () => {
        expect(deriveReadinessV1({ lifecycle: 'active', openBinding: null, dbNowMs: NOW })).toBe('no_open_transport')
        expect(deriveReadinessV1({ lifecycle: 'active', openBinding: { trustState: 'pending', attestedUntilMs: NOW + 1000 }, dbNowMs: NOW }))
            .toBe('no_open_transport')
    })

    it('refuses readiness for every lifecycle that is not active, however fresh the transport', () => {
        for (const lifecycle of ['pending_approval', 'rejected', 'disabled', 'retired']) {
            expect(deriveReadinessV1({ lifecycle, openBinding: fresh, dbNowMs: NOW })).toBe('not_admitted')
        }
    })
})
