import { describe, expect, it } from 'vitest'

import {
    ATTESTATION_REFRESH_FLOOR_MS_V1,
    ATTESTATION_WINDOW_MS_V1,
    attestationWindowUntilV1,
    bindingCanonicalPairV1,
    decideWhatsAppAccountAttestationV1,
    isUsableProviderPairV1,
    providerPairsEqualV1,
    renderPnForDisplayV1,
    type OpenBindingSnapshotV1,
} from './whatsapp-account-attestation'

const PN = '79995551122'
const LID = '128773311223344'
const OTHER_PN = '79995559988'
const OTHER_LID = '128773399887766'
const NOW = 1_800_000_000_000

const pair = { pnUser: PN, lidUser: LID }
const otherPair = { pnUser: OTHER_PN, lidUser: OTHER_LID }

function openBinding(overrides: Partial<OpenBindingSnapshotV1> = {}): OpenBindingSnapshotV1 {
    return {
        bindingId: 'binding-1',
        accountId: 'account-1',
        trustState: 'pending',
        attestedPnValue: PN,
        attestedLidValue: LID,
        claimedPnValue: PN,
        claimedLidValue: LID,
        attestedUntilMs: NOW + ATTESTATION_WINDOW_MS_V1,
        operatorConfirmed: false,
        ...overrides,
    }
}

function decide(input: Partial<Parameters<typeof decideWhatsAppAccountAttestationV1>[0]> = {}) {
    return decideWhatsAppAccountAttestationV1({
        observed: pair,
        openBinding: null,
        unchanged: null,
        dbNowMs: NOW,
        ...input,
    })
}

describe('usable pair', () => {
    it('accepts a complete, shape-valid, distinct pair', () => {
        expect(isUsableProviderPairV1(pair)).toBe(true)
    })

    it('refuses a half set, a malformed half and an identical pair', () => {
        expect(isUsableProviderPairV1({ pnUser: PN, lidUser: null })).toBe(false)
        expect(isUsableProviderPairV1({ pnUser: PN })).toBe(false)
        expect(isUsableProviderPairV1({ pnUser: `${PN}@c.us`, lidUser: LID })).toBe(false)
        expect(isUsableProviderPairV1({ pnUser: ` ${PN}`, lidUser: LID })).toBe(false)
        expect(isUsableProviderPairV1({ pnUser: PN, lidUser: PN })).toBe(false)
        expect(isUsableProviderPairV1(null)).toBe(false)
    })

    it('compares by exact provider form, never a normalized form', () => {
        expect(providerPairsEqualV1(pair, { pnUser: PN, lidUser: LID })).toBe(true)
        // A leading 8 is the same subscriber for a human and a different key here.
        expect(providerPairsEqualV1(pair, { pnUser: `8${PN.slice(1)}`, lidUser: LID })).toBe(false)
    })
})

describe('decision table', () => {
    it('first coherent READY opens the first generation', () => {
        expect(decide()).toMatchObject({ action: 'open_first_generation', outcome: 'opened_first_generation', closeReason: null })
    })

    it('duplicate READY inside a live window performs no write', () => {
        expect(decide({ openBinding: openBinding(), unchanged: true }))
            .toMatchObject({ action: 'none', outcome: 'attestation_still_fresh' })
    })

    it('re-attests once the window falls below the refresh floor', () => {
        const snapshot = openBinding({ attestedUntilMs: NOW + ATTESTATION_REFRESH_FLOOR_MS_V1 - 1 })
        expect(decide({ openBinding: snapshot, unchanged: true }))
            .toMatchObject({ action: 'reattest_open_generation', outcome: 'reattested' })
    })

    it('re-attests the same pair after a process restart, where the runtime signal is null', () => {
        const snapshot = openBinding({ attestedUntilMs: NOW + 1 })
        const decision = decide({ openBinding: snapshot, unchanged: null })
        expect(decision).toMatchObject({ action: 'reattest_open_generation', outcome: 'reattested' })
    })

    it('re-attests a verified binding whose window has lapsed', () => {
        const snapshot = openBinding({ trustState: 'verified', operatorConfirmed: true, attestedUntilMs: NOW - 1 })
        expect(decide({ openBinding: snapshot, unchanged: null }))
            .toMatchObject({ action: 'reattest_open_generation', outcome: 'reattested' })
    })

    it('supersedes a pending generation whose window has lapsed, because the database can never revive it', () => {
        const snapshot = openBinding({ trustState: 'pending', attestedUntilMs: NOW - 1 })
        expect(decide({ openBinding: snapshot, unchanged: true }))
            .toMatchObject({ action: 'supersede_expired_generation', outcome: 'superseded_expired_pending', closeReason: 'superseded' })
    })

    it('replaces the generation when the durable pair differs', () => {
        expect(decide({ observed: otherPair, openBinding: openBinding(), unchanged: false }))
            .toMatchObject({ action: 'replace_mismatched_generation', outcome: 'replaced_on_pair_change', closeReason: 'account_changed' })
    })

    it('replaces the generation when only the LID half moved', () => {
        expect(decide({ observed: { pnUser: PN, lidUser: OTHER_LID }, openBinding: openBinding(), unchanged: null }))
            .toMatchObject({ action: 'replace_mismatched_generation', closeReason: 'account_changed' })
    })

    it('performs no write for an unusable observation', () => {
        expect(decide({ observed: null, openBinding: openBinding() }))
            .toMatchObject({ action: 'none', outcome: 'pair_not_usable' })
    })

    it('refuses a binding that asserts no durable pair', () => {
        const snapshot = openBinding({ attestedPnValue: null, attestedLidValue: null, claimedPnValue: null, claimedLidValue: null })
        expect(decide({ openBinding: snapshot })).toMatchObject({ action: 'refuse', outcome: 'binding_pair_missing' })
    })

    it('falls back to the claim when nothing is attested yet', () => {
        const snapshot = openBinding({ attestedPnValue: null, attestedLidValue: null, attestedUntilMs: null })
        expect(bindingCanonicalPairV1(snapshot)).toEqual(pair)
        expect(decide({ openBinding: snapshot, unchanged: null }))
            .toMatchObject({ action: 'reattest_open_generation' })
    })

    it('prefers the attested set over the claim, so a binding with no claim is still readable', () => {
        // A transport-asserted binding always carries equal attested and claimed
        // values, because the database refuses anything else. A provider-verified
        // binding may carry the attested set alone, and the durable pair is then
        // the attested one: falling back to the claim would read it as missing.
        const snapshot = openBinding({ claimedPnValue: null, claimedLidValue: null })
        expect(bindingCanonicalPairV1(snapshot)).toEqual(pair)
        expect(decide({ openBinding: snapshot, unchanged: null, dbNowMs: NOW + ATTESTATION_WINDOW_MS_V1 - 1 }))
            .toMatchObject({ action: 'reattest_open_generation', outcome: 'reattested' })
    })
})

describe('the runtime signal never decides identity', () => {
    it('refuses when the signal claims no change but the durable pair differs', () => {
        const decision = decide({ observed: otherPair, openBinding: openBinding(), unchanged: true })
        expect(decision).toMatchObject({ action: 'refuse', outcome: 'contradiction_unchanged_true_pair_differs', closeReason: null })
    })

    it('refuses when the signal claims a change but the durable pair is equal', () => {
        const decision = decide({ openBinding: openBinding({ attestedUntilMs: NOW + 1 }), unchanged: false })
        expect(decision).toMatchObject({ action: 'refuse', outcome: 'contradiction_unchanged_false_pair_equal', closeReason: null })
    })

    it('reaches the same identity outcome for every signal value when the database agrees', () => {
        const snapshot = openBinding({ attestedUntilMs: NOW + 1 })
        const outcomes = [null, true].map((unchanged) => decide({ openBinding: snapshot, unchanged }).action)
        expect(new Set(outcomes)).toEqual(new Set(['reattest_open_generation']))
    })

    it('opens the first generation whatever the signal says, because there is nothing to contradict', () => {
        for (const unchanged of [null, true, false]) {
            expect(decide({ unchanged }).action).toBe('open_first_generation')
        }
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

describe('display rendering', () => {
    it('renders a PN for the authenticated UI without changing any stored value', () => {
        expect(renderPnForDisplayV1(PN)).toBe('+7 999 555-11-22')
        expect(renderPnForDisplayV1('123456789012')).toBe('+123456789012')
        expect(renderPnForDisplayV1('not-a-number')).toBe('')
    })
})
