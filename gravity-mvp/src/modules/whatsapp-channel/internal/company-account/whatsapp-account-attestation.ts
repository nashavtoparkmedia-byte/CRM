/**
 * M2A1-S3 attestation domain.
 *
 * Pure decision logic for the company-account writer: it takes what the runtime
 * observed and what the database currently holds for the slot, and returns the
 * single durable action to perform. It has no database, no clock and no I/O, so
 * every case in the decision table is directly testable.
 *
 * The durable decision is made from the database binding alone. The runtime's
 * process-local `unchanged` signal is supplementary consistency evidence: it can
 * only cause a refusal, never a different identity outcome.
 */

/** One provider identity in exact provider form. No phone normalization, ever. */
export type ProviderKeyKindV1 = 'whatsapp_pn_user' | 'whatsapp_lid_user'

/**
 * The canonical pair of a slot: the ordered tuple in exact provider form.
 * Comparison is byte equality. Display normalization never touches these values.
 */
export interface CanonicalProviderPairV1 {
    pnUser: string
    lidUser: string
}

/** Durable state of the slot's open binding, as the database holds it. */
export interface OpenBindingSnapshotV1 {
    bindingId: string
    accountId: string
    trustState: 'pending' | 'verified'
    attestedPnValue: string | null
    attestedLidValue: string | null
    claimedPnValue: string | null
    claimedLidValue: string | null
    /** Epoch milliseconds of `attestedUntil`, or null when nothing is attested yet. */
    attestedUntilMs: number | null
    operatorConfirmed: boolean
}

export const WHATSAPP_ACCOUNT_ATTESTATION_ACTIONS_V1 = [
    'none',
    'open_first_generation',
    'reattest_open_generation',
    'supersede_expired_generation',
    'replace_mismatched_generation',
    'refuse',
] as const
export type WhatsAppAccountAttestationActionV1 = (typeof WHATSAPP_ACCOUNT_ATTESTATION_ACTIONS_V1)[number]

export const WHATSAPP_ACCOUNT_ATTESTATION_OUTCOMES_V1 = [
    'opened_first_generation',
    'reattested',
    'attestation_still_fresh',
    'superseded_expired_pending',
    'replaced_on_pair_change',
    'pair_not_usable',
    'binding_pair_missing',
    'contradiction_unchanged_true_pair_differs',
    'contradiction_unchanged_false_pair_equal',
] as const
export type WhatsAppAccountAttestationOutcomeV1 = (typeof WHATSAPP_ACCOUNT_ATTESTATION_OUTCOMES_V1)[number]

export interface WhatsAppAccountAttestationDecisionV1 {
    action: WhatsAppAccountAttestationActionV1
    outcome: WhatsAppAccountAttestationOutcomeV1
    /** The close reason to record on the previous binding, when one is replaced. */
    closeReason: 'superseded' | 'account_changed' | null
}

/**
 * The attestation ceiling the database enforces is one hour. The window is
 * deliberately shorter so that clock skew between this process and the database
 * can never produce a window outside `(lastAttestedAt, lastAttestedAt + 1 hour]`.
 */
export const ATTESTATION_WINDOW_MS_V1 = 45 * 60 * 1000

/**
 * A live attestation is only refreshed once less than this remains, so repeated
 * READY events inside one window perform no write at all.
 */
export const ATTESTATION_REFRESH_FLOOR_MS_V1 = 15 * 60 * 1000

const PN_USER = /^[0-9]{5,64}$/u
const LID_USER = /^[0-9]{5,64}$/u

function usableHalf(kind: ProviderKeyKindV1, value: unknown): value is string {
    if (typeof value !== 'string') return false
    if (value !== value.trim() || value.length === 0 || value.length > 128) return false
    return kind === 'whatsapp_pn_user' ? PN_USER.test(value) : LID_USER.test(value)
}

/**
 * A pair is usable only when both halves are present, shape-valid and distinct.
 * Anything else is not a pair and produces no durable write.
 */
export function isUsableProviderPairV1(pair: { pnUser?: unknown; lidUser?: unknown } | null | undefined): pair is CanonicalProviderPairV1 {
    if (!pair) return false
    if (!usableHalf('whatsapp_pn_user', pair.pnUser)) return false
    if (!usableHalf('whatsapp_lid_user', pair.lidUser)) return false
    return pair.pnUser !== pair.lidUser
}

/**
 * The pair a binding durably asserts: the attested set once recorded, otherwise
 * the claim it opened with. Returns null when the row asserts neither, which is
 * a state this writer never creates and always refuses to act on.
 */
export function bindingCanonicalPairV1(snapshot: OpenBindingSnapshotV1): CanonicalProviderPairV1 | null {
    if (snapshot.attestedPnValue !== null && snapshot.attestedLidValue !== null) {
        return { pnUser: snapshot.attestedPnValue, lidUser: snapshot.attestedLidValue }
    }
    if (snapshot.claimedPnValue !== null && snapshot.claimedLidValue !== null) {
        return { pnUser: snapshot.claimedPnValue, lidUser: snapshot.claimedLidValue }
    }
    return null
}

export function providerPairsEqualV1(left: CanonicalProviderPairV1, right: CanonicalProviderPairV1): boolean {
    return left.pnUser === right.pnUser && left.lidUser === right.lidUser
}

export interface WhatsAppAccountAttestationInputV1 {
    /** The observed pair, or null when the observation was not usable. */
    observed: CanonicalProviderPairV1 | null
    /** The slot's open binding as the database holds it, or null when none is open. */
    openBinding: OpenBindingSnapshotV1 | null
    /** Supplementary runtime evidence only; never decides identity. */
    unchanged: boolean | null
    /** The database clock, read in the same transaction. */
    dbNowMs: number
    refreshFloorMs?: number
}

/**
 * The single durable decision for one observation.
 *
 * Identity is authored from `openBinding` alone. `unchanged` is compared against
 * the database answer only to detect disagreement: when the two contradict each
 * other the writer refuses and leaves identity exactly as it is, because a
 * disagreement means the truth is not known and these rows are permanent.
 */
export function decideWhatsAppAccountAttestationV1(input: WhatsAppAccountAttestationInputV1): WhatsAppAccountAttestationDecisionV1 {
    const { observed, openBinding, unchanged, dbNowMs } = input
    const refreshFloorMs = input.refreshFloorMs ?? ATTESTATION_REFRESH_FLOOR_MS_V1

    if (observed === null) {
        return { action: 'none', outcome: 'pair_not_usable', closeReason: null }
    }
    if (openBinding === null) {
        return { action: 'open_first_generation', outcome: 'opened_first_generation', closeReason: null }
    }

    const durable = bindingCanonicalPairV1(openBinding)
    if (durable === null) {
        return { action: 'refuse', outcome: 'binding_pair_missing', closeReason: null }
    }

    if (!providerPairsEqualV1(durable, observed)) {
        if (unchanged === true) {
            return { action: 'refuse', outcome: 'contradiction_unchanged_true_pair_differs', closeReason: null }
        }
        return { action: 'replace_mismatched_generation', outcome: 'replaced_on_pair_change', closeReason: 'account_changed' }
    }

    if (unchanged === false) {
        return { action: 'refuse', outcome: 'contradiction_unchanged_false_pair_equal', closeReason: null }
    }

    // The database refuses to re-attest a pending binding whose recorded window
    // has lapsed, so that generation can never be verified and is superseded.
    // The same lapse on a verified binding is revived by this observation.
    const lapsed = openBinding.attestedUntilMs !== null && openBinding.attestedUntilMs <= dbNowMs
    if (lapsed && openBinding.trustState === 'pending') {
        return { action: 'supersede_expired_generation', outcome: 'superseded_expired_pending', closeReason: 'superseded' }
    }

    if (openBinding.attestedUntilMs !== null && openBinding.attestedUntilMs - dbNowMs > refreshFloorMs) {
        return { action: 'none', outcome: 'attestation_still_fresh', closeReason: null }
    }

    return { action: 'reattest_open_generation', outcome: 'reattested', closeReason: null }
}

/** The attestation window for a write, derived from the database clock. */
export function attestationWindowUntilV1(dbNowMs: number): Date {
    return new Date(dbNowMs + ATTESTATION_WINDOW_MS_V1)
}

/**
 * Display-only rendering of a PN for the authenticated confirmation UI. It is
 * never stored, never compared and never used to resolve an account: the stored
 * key keeps the exact provider form.
 */
export function renderPnForDisplayV1(pnUser: string): string {
    if (!PN_USER.test(pnUser)) return ''
    if (pnUser.length === 11 && (pnUser.startsWith('7') || pnUser.startsWith('8'))) {
        return `+7 ${pnUser.slice(1, 4)} ${pnUser.slice(4, 7)}-${pnUser.slice(7, 9)}-${pnUser.slice(9)}`
    }
    return `+${pnUser}`
}
