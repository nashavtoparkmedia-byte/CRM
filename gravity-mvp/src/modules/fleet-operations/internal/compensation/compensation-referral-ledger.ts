/**
 * The Cash access ledger: one append-only, hash-chained list of events per
 * canonical contact, and the pure reads the access and referral decisions
 * take from it.
 *
 * The ledger is the only record of referral codes, captures, qualification
 * decisions, referral entitlements, manager sanctions, manual grants and
 * denials, and the dismissal readings an invitation was decided on. Nothing
 * here touches money: C1 keeps every monetary rule, and a grant only opens an
 * order window in compensation-access.
 *
 * Who may write each kind is fixed here and again by the database: system
 * kinds only by the system, manager kinds only by a signed staff session that
 * holds the capability. A row that breaks that rule is never folded, whoever
 * managed to write it.
 *
 * The hash chain is detection, not prevention: the database role can rewrite
 * any row. verifyCashAccessChainV1 recomputes every link, so a forged,
 * edited, resequenced or deleted row is found when the chain is checked.
 */

import { createHash } from 'node:crypto'

import {
    CASH_ACCESS_MANAGE_CAPABILITY_V1,
    type CashAccessActorV1,
    type CashManualAccessV1,
    type CashReferralEntitlementV1,
} from './compensation-access'
import {
    CASH_REFERRAL_QUALIFY_CAPABILITY_V1,
    type CashReferralDismissalReadingV1,
    type CashReferralSanctionV1,
} from './compensation-referral-qualification'

export const CASH_ACCESS_EVENT_KINDS_V1 = [
    'referral_code_issued',
    'referral_captured',
    'referral_decided',
    'referral_entitlement_granted',
    'referral_entitlement_revoked',
    'referral_sanctioned',
    'manual_granted',
    'manual_denied',
    'manual_cleared',
    'invitee_dismissal_observed',
] as const

export type CashAccessEventKindV1 = typeof CASH_ACCESS_EVENT_KINDS_V1[number]

/** The one writer each kind admits. */
export const CASH_ACCESS_EVENT_WRITER_V1: Readonly<Record<
    CashAccessEventKindV1,
    { actorKind: 'system' } | { actorKind: 'signed_staff_session'; capability: string }
>> = {
    referral_code_issued: { actorKind: 'system' },
    referral_captured: { actorKind: 'system' },
    referral_decided: { actorKind: 'system' },
    referral_entitlement_granted: { actorKind: 'system' },
    invitee_dismissal_observed: { actorKind: 'system' },
    referral_entitlement_revoked: { actorKind: 'signed_staff_session', capability: CASH_ACCESS_MANAGE_CAPABILITY_V1 },
    manual_granted: { actorKind: 'signed_staff_session', capability: CASH_ACCESS_MANAGE_CAPABILITY_V1 },
    manual_denied: { actorKind: 'signed_staff_session', capability: CASH_ACCESS_MANAGE_CAPABILITY_V1 },
    manual_cleared: { actorKind: 'signed_staff_session', capability: CASH_ACCESS_MANAGE_CAPABILITY_V1 },
    referral_sanctioned: { actorKind: 'signed_staff_session', capability: CASH_REFERRAL_QUALIFY_CAPABILITY_V1 },
}

/** A JSON value as the ledger stores it in `payload`. */
export type CashAccessJsonV1 = null | boolean | number | string | CashAccessJsonV1[] | { [key: string]: CashAccessJsonV1 }

/** One ledger row, as stored. */
export interface CashAccessEventV1 {
    id: string
    chainContactId: string
    seq: number
    kind: CashAccessEventKindV1
    lineageDigest: string
    codeHash: string | null
    attributionId: string | null
    payload: { [key: string]: CashAccessJsonV1 }
    actorKind: 'signed_staff_session' | 'system'
    actorId: string
    actorCapability: string | null
    actorSessionId: string | null
    actorAuthenticatedAt: Date | null
    reason: string | null
    idempotencyKey: string
    /** The database clock at the insert. */
    occurredAt: Date
    prevHash: string | null
    hash: string
}

function canonicalJsonV1(value: CashAccessJsonV1): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonicalJsonV1).join(',')}]`
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonV1(value[key])}`).join(',')}}`
}

/** The hash of one row: every column but the hash itself, in a fixed order, times in UTC. */
export function cashAccessEventHashV1(event: Omit<CashAccessEventV1, 'hash'>): string {
    const canonical = canonicalJsonV1([
        event.id,
        event.chainContactId,
        event.seq,
        event.kind,
        event.lineageDigest,
        event.codeHash,
        event.attributionId,
        event.payload,
        event.actorKind,
        event.actorId,
        event.actorCapability,
        event.actorSessionId,
        event.actorAuthenticatedAt === null ? null : event.actorAuthenticatedAt.toISOString(),
        event.reason,
        event.idempotencyKey,
        event.occurredAt.toISOString(),
        event.prevHash,
    ])
    return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * The form a park's person key is stored in: a domain-separated sha256, so
 * the ledger and the attribution hold no licence number.
 */
export function cashReferralPersonKeyDigestV1(externalPersonKey: string): string {
    return createHash('sha256').update(`yoko.cash-referral.person-key.v1:${externalPersonKey}`, 'utf8').digest('hex')
}

/** Whether a row was written by the one writer its kind admits. */
export function cashAccessWriterAllowedV1(
    event: Pick<CashAccessEventV1, 'kind' | 'actorKind' | 'actorId' | 'actorCapability' | 'actorSessionId' | 'actorAuthenticatedAt' | 'reason'>,
): boolean {
    const writer = CASH_ACCESS_EVENT_WRITER_V1[event.kind]
    if (writer === undefined || event.actorId.trim() === '') return false
    if (writer.actorKind === 'system') {
        return event.actorKind === 'system' && event.actorCapability === null && event.actorSessionId === null
    }
    return event.actorKind === 'signed_staff_session'
        && event.actorCapability === writer.capability
        && event.actorSessionId !== null
        && event.actorAuthenticatedAt !== null
        && event.reason !== null
        && event.reason.trim().length >= 10
}

export type CashAccessChainCheckV1 =
    | { ok: true; length: number }
    | {
        ok: false
        problem: 'chain_mixed' | 'seq_gap' | 'prev_hash_mismatch' | 'hash_mismatch' | 'writer_not_allowed'
        seq: number
    }

/**
 * Recomputes one contact's chain. Rows must start at seq 1 with no gap, each
 * pointing at the hash of the row before it, each hashing to its own stored
 * value, and each written by the writer its kind admits.
 */
export function verifyCashAccessChainV1(events: readonly CashAccessEventV1[]): CashAccessChainCheckV1 {
    const ordered = [...events].sort((left, right) => left.seq - right.seq)
    let previous: string | null = null
    for (let index = 0; index < ordered.length; index += 1) {
        const event = ordered[index]
        if (event.chainContactId !== ordered[0].chainContactId) return { ok: false, problem: 'chain_mixed', seq: event.seq }
        if (event.seq !== index + 1) return { ok: false, problem: 'seq_gap', seq: event.seq }
        if (event.prevHash !== previous) return { ok: false, problem: 'prev_hash_mismatch', seq: event.seq }
        const { hash, ...rest } = event
        if (cashAccessEventHashV1(rest) !== hash) return { ok: false, problem: 'hash_mismatch', seq: event.seq }
        if (!cashAccessWriterAllowedV1(event)) return { ok: false, problem: 'writer_not_allowed', seq: event.seq }
        previous = hash
    }
    return { ok: true, length: ordered.length }
}

function actorOfV1(event: CashAccessEventV1): CashAccessActorV1 {
    return event.actorKind === 'signed_staff_session'
        ? { kind: 'signed_staff_session', principalId: event.actorId, capabilities: event.actorCapability === null ? [] : [event.actorCapability] }
        : { kind: 'system', principalId: event.actorId }
}

const ACCESS_KINDS_V1: ReadonlySet<CashAccessEventKindV1> = new Set([
    'referral_entitlement_granted',
    'referral_entitlement_revoked',
    'manual_granted',
    'manual_denied',
    'manual_cleared',
])

export interface CashAccessLedgerFoldV1 {
    /** The latest referral entitlement and its revoke, if any: S0's `referral` input. */
    referral: CashReferralEntitlementV1 | null
    /** The latest standing manual decision: S0's `manual` input. */
    manual: CashManualAccessV1 | null
    /**
     * An access event was recorded under an earlier lineage of this contact
     * and nothing recorded under the current lineage has followed it. The
     * person was merged since; access waits for a manager to look again.
     */
    staleLineage: boolean
}

/**
 * The access inputs one contact's chain gives under its current lineage.
 * Only rows written by their kind's writer and recorded under the current
 * lineage count; a merge carries nothing over by itself.
 */
export function foldCashAccessLedgerV1(events: readonly CashAccessEventV1[], currentLineageDigest: string): CashAccessLedgerFoldV1 {
    const ordered = [...events].sort((left, right) => left.seq - right.seq)
    let referral: CashReferralEntitlementV1 | null = null
    let manual: CashManualAccessV1 | null = null
    let staleLineage = false
    for (const event of ordered) {
        if (!ACCESS_KINDS_V1.has(event.kind) || !cashAccessWriterAllowedV1(event)) continue
        if (event.lineageDigest !== currentLineageDigest) {
            staleLineage = true
            continue
        }
        staleLineage = false
        switch (event.kind) {
            case 'referral_entitlement_granted':
                referral = { confirmedAt: event.occurredAt, revokedAt: null }
                break
            case 'referral_entitlement_revoked':
                if (referral !== null && referral.revokedAt === null) referral = { confirmedAt: referral.confirmedAt, revokedAt: event.occurredAt }
                break
            case 'manual_granted':
            case 'manual_denied':
                manual = { decision: event.kind === 'manual_granted' ? 'grant' : 'deny', decidedAt: event.occurredAt, actor: actorOfV1(event) }
                break
            case 'manual_cleared':
                manual = null
                break
        }
    }
    return { referral, manual, staleLineage }
}

/** The latest sanction a signed staff session recorded for one invitation. */
export function latestCashReferralSanctionV1(events: readonly CashAccessEventV1[], attributionId: string): CashReferralSanctionV1 | null {
    let latest: CashReferralSanctionV1 | null = null
    for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
        if (event.kind !== 'referral_sanctioned' || event.attributionId !== attributionId || !cashAccessWriterAllowedV1(event)) continue
        latest = { attributionId, sanctionedAt: event.occurredAt, actor: actorOfV1(event) }
    }
    return latest
}

/** The dismissal readings kept for one invitation, per earlier profile. */
export function keptCashReferralDismissalsV1(
    events: readonly CashAccessEventV1[],
    attributionId: string,
): ReadonlyMap<string, readonly CashReferralDismissalReadingV1[]> {
    const kept = new Map<string, CashReferralDismissalReadingV1[]>()
    for (const event of events) {
        if (event.kind !== 'invitee_dismissal_observed' || event.attributionId !== attributionId || !cashAccessWriterAllowedV1(event)) continue
        const { profileKey, dismissedAt, readAt } = event.payload
        if (typeof profileKey !== 'string' || typeof dismissedAt !== 'string' || typeof readAt !== 'string') continue
        const reading = { dismissedAt: new Date(dismissedAt), readAt: new Date(readAt) }
        if (Number.isNaN(reading.dismissedAt.getTime()) || Number.isNaN(reading.readAt.getTime())) continue
        kept.set(profileKey, [...(kept.get(profileKey) ?? []), reading])
    }
    return kept
}
