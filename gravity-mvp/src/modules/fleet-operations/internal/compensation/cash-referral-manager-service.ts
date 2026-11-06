/**
 * The Cash referral manager tools over their port: finding people, a person's
 * card, recording and withdrawing an invitation, and granting and revoking
 * access. The rules are cash-referral-manager's; this module reads what they
 * need, applies them and writes what they decide.
 *
 * Every write first proves its actor (a signed staff session with the
 * capability its kind needs) and that the screen it came from still names
 * the current person: a contact merged or moved since the manager looked is
 * refused rather than guessed at. A request id makes a retry after a failure
 * write nothing twice; a chain another writer moved meanwhile is read again
 * and decided again once.
 */

import { compensationLineageDigestV1 } from './compensation-pilot-lineage'
import type { CashAccessEventDraftV1, CashAccessStaffActorDraftV1 } from './legacy-prisma-cash-referral-ledger-adapter'
import type { CashAccessEventV1, CashAccessJsonV1 } from './compensation-referral-ledger'
import {
    cashAccessManagerViewV1,
    cashReferralDisplayNameV1,
    cashReferralLicenceKeyV1,
    cashReferralLinkReasonV1,
    cashReferralLinkWithdrawableV1,
    cashReferralRequestIdValidV1,
    cashReferralWithdrawReasonV1,
    cashStaffActorV1,
    cashStaffAuthorityForV1,
    decideCashAccessGrantV1,
    decideCashAccessRevokeV1,
    decideCashReferralLinkV1,
    groupCashReferralCandidatesV1,
    parseCashReferralManagerQueryV1,
    type CashAccessGrantBasisV1,
    type CashAccessManagerViewV1,
    type CashReferralInvitationRowV1,
    type CashReferralLineageReadV1,
    type CashReferralManagerCandidateV1,
    type CashReferralManagerHitV1,
    type CashReferralManagerProfileV1,
    type CashReferralManagerQueryV1,
    type CashStaffAuthorityRefusalV1,
    type CashStaffPurposeV1,
    type CashStaffAuthorityV1,
} from './cash-referral-manager'

export const CASH_REFERRAL_MANAGER_SEARCH_ROWS_V1 = 60

export interface CashReferralManagerPortV1 {
    now(): Date
    /** Each park's display name, from the park metadata; no credential. */
    parkNames(): Promise<ReadonlyMap<string, string>>
    searchProfiles(query: CashReferralManagerQueryV1, limit: number): Promise<CashReferralManagerHitV1[]>
    profilesOfContacts(contactIds: readonly string[]): Promise<CashReferralManagerProfileV1[]>
    resolveLineage(contactId: string): Promise<CashReferralLineageReadV1>
    confirmedMainDriver(contactId: string, driverIds: readonly string[]): Promise<{ status: 'confirmed'; driverId: string } | { status: 'not_confirmed' | 'busy' }>
    readChain(chainContactId: string): Promise<CashAccessEventV1[]>
    listInvitationsOfContacts(contactIds: readonly string[]): Promise<CashReferralInvitationRowV1[]>
    findInvitation(attributionId: string): Promise<CashReferralInvitationRowV1 | null>
    readInvitationLinkEvents(attributionIds: readonly string[]): Promise<CashAccessEventV1[]>
    recordManagerInvitation(input: {
        inviterContactId: string
        inviterLineageDigest: string
        inviteeContactId: string
        inviteeLineage: readonly string[]
        actor: CashAccessStaffActorDraftV1
        reason: string
        payload: { [key: string]: CashAccessJsonV1 }
        idempotencyKey: string
    }): Promise<{ outcome: 'recorded' | 'already_recorded'; attributionId: string } | { outcome: 'conflict' | 'busy' }>
    withdrawManagerInvitation(input: {
        attributionId: string
        expectedVersion: number
        actor: CashAccessStaffActorDraftV1
        reason: string
        payload: { [key: string]: CashAccessJsonV1 }
        idempotencyKey: string
    }): Promise<'withdrawn' | 'already_withdrawn' | 'version_conflict' | 'busy'>
    appendManagerAccessEvents(drafts: readonly CashAccessEventDraftV1[]): Promise<'written' | 'already_written' | 'busy'>
}

// ---------------------------------------------------------------------------
// Search.
// ---------------------------------------------------------------------------

function namedV1(profiles: readonly CashReferralManagerProfileV1[], names: ReadonlyMap<string, string>): CashReferralManagerProfileV1[] {
    return profiles.map((profile) => ({
        ...profile,
        parkName: profile.parkName ?? (profile.externalParkId === null ? null : names.get(profile.externalParkId) ?? null),
    }))
}

export type CashReferralManagerSearchV1 =
    | { status: 'ok'; candidates: readonly CashReferralManagerCandidateV1[]; truncated: boolean }
    | { status: 'refused'; reason: 'query_too_short' | 'query_too_long' }

export async function searchCashReferralPeopleV1(port: CashReferralManagerPortV1, raw: unknown): Promise<CashReferralManagerSearchV1> {
    const parsed = parseCashReferralManagerQueryV1(raw)
    if (!parsed.ok) return { status: 'refused', reason: parsed.refusal }
    const names = await port.parkNames()
    const hits = (await port.searchProfiles(parsed.query, CASH_REFERRAL_MANAGER_SEARCH_ROWS_V1))
        .map((hit) => ({ ...hit, profile: namedV1([hit.profile], names)[0] }))
    const lineages = new Map<string, CashReferralLineageReadV1>()
    const contactIds = [...new Set(hits.flatMap((hit) => (hit.profile.contactId === null ? [] : [hit.profile.contactId])))]
    const reads = await Promise.all(contactIds.map((contactId) => port.resolveLineage(contactId)))
    contactIds.forEach((contactId, index) => lineages.set(contactId, reads[index]))
    const lineageOf = new Map<string, readonly string[]>()
    for (const read of lineages.values()) {
        if (read.status === 'resolved') lineageOf.set(read.canonicalContactId, read.contactIds)
    }
    const allContacts = [...new Set([...lineageOf.values()].flat())]
    const profiles = namedV1(await port.profilesOfContacts(allContacts), names)
    const profilesOf = new Map<string, CashReferralManagerProfileV1[]>()
    for (const [canonical, lineage] of lineageOf) {
        profilesOf.set(canonical, profiles.filter((profile) => profile.contactId !== null && lineage.includes(profile.contactId)))
    }
    return {
        status: 'ok',
        candidates: groupCashReferralCandidatesV1(hits, lineages, profilesOf),
        truncated: hits.length >= CASH_REFERRAL_MANAGER_SEARCH_ROWS_V1,
    }
}

// ---------------------------------------------------------------------------
// A person's card.
// ---------------------------------------------------------------------------

export interface CashReferralInvitationEntryV1 {
    attributionId: string
    source: 'telegram' | 'manager'
    state: string
    /** The other person of the invitation: the invitee on the inviter's card, the inviter on the invitee's. */
    otherContactId: string | null
    otherName: string | null
    at: Date
    recordedBy: string | null
    reason: string | null
    withdrawnAt: Date | null
    withdrawnBy: string | null
    withdrawable: boolean
    version: number
}

export interface CashReferralPersonCardV1 {
    personContactId: string
    displayName: string
    lineage: readonly string[]
    profiles: readonly CashReferralManagerProfileV1[]
    /**
     * Whether Cash can bind access and money to this person today:
     * confirmed      Contacts confirms one of the profiles as the main driver
     * not_confirmed  no profile is confirmed yet; access applies once one is
     * merged         the person's contacts were merged; Cash refuses them
     * busy           Contacts is busy; try again
     */
    cashIdentity: 'confirmed' | 'not_confirmed' | 'merged' | 'busy'
    access: CashAccessManagerViewV1
    invited: readonly CashReferralInvitationEntryV1[]
    invitedBy: readonly CashReferralInvitationEntryV1[]
}

function payloadLabelV1(event: CashAccessEventV1 | undefined): string | null {
    const label = event?.payload.operatorLabel
    return typeof label === 'string' && label.trim() !== '' ? label : null
}



export async function cashReferralPersonCardV1(
    port: CashReferralManagerPortV1,
    contactId: string,
): Promise<{ status: 'ok'; card: CashReferralPersonCardV1 } | { status: 'person_unresolved' }> {
    const read = typeof contactId === 'string' && contactId.trim() !== '' ? await port.resolveLineage(contactId) : { status: 'missing' as const }
    if (read.status !== 'resolved') return { status: 'person_unresolved' }
    const personContactId = read.canonicalContactId
    const lineage = read.contactIds
    const profiles = namedV1(await port.profilesOfContacts(lineage), await port.parkNames())
    const merged = lineage.length !== 1
    const identity = merged ? null : await port.confirmedMainDriver(personContactId, profiles.map((profile) => profile.driverId))
    const cashIdentity: CashReferralPersonCardV1['cashIdentity'] = merged ? 'merged' : identity!.status

    const access = cashAccessManagerViewV1(await port.readChain(personContactId), compensationLineageDigestV1(lineage))

    const rows = await port.listInvitationsOfContacts(lineage)
    const events = await port.readInvitationLinkEvents(rows.filter((row) => row.source === 'manager').map((row) => row.attributionId))
    const others = [...new Set(rows.flatMap((row) => [row.inviterContactId, row.inviteeContactId])
        .filter((id): id is string => id !== null && !lineage.includes(id)))]
    const otherProfiles = await port.profilesOfContacts(others)
    const nameOf = (id: string | null) => (id === null ? null : cashReferralDisplayNameV1(otherProfiles.filter((profile) => profile.contactId === id)))
    const entry = (row: CashReferralInvitationRowV1, otherContactId: string | null): CashReferralInvitationEntryV1 => {
        const ofRow = (event: CashAccessEventV1) => row.source === 'manager' && event.payload.invitationId === row.attributionId
        const recorded = events.find((event) => ofRow(event) && event.kind === 'referral_link_recorded')
        const withdrawn = events.find((event) => ofRow(event) && event.kind === 'referral_link_withdrawn')
        return {
            attributionId: row.attributionId,
            source: row.source,
            state: row.state,
            otherContactId,
            otherName: nameOf(otherContactId),
            at: row.source === 'manager' ? row.decidedAt ?? row.capturedAt : row.capturedAt,
            recordedBy: payloadLabelV1(recorded),
            reason: recorded?.reason ?? null,
            withdrawnAt: withdrawn?.occurredAt ?? null,
            withdrawnBy: payloadLabelV1(withdrawn),
            withdrawable: cashReferralLinkWithdrawableV1(row),
            version: row.version,
        }
    }
    const invited = rows.filter((row) => lineage.includes(row.inviterContactId)).map((row) => entry(row, row.inviteeContactId))
    // A self-invitation the Telegram pass rejected names this person twice; it is shown once, as theirs.
    const invitedBy = rows.filter((row) => row.inviteeContactId !== null && lineage.includes(row.inviteeContactId)
        && !lineage.includes(row.inviterContactId))
        .map((row) => entry(row, row.inviterContactId))

    return {
        status: 'ok',
        card: {
            personContactId,
            displayName: cashReferralDisplayNameV1(profiles) ?? 'Без имени',
            lineage,
            profiles,
            cashIdentity,
            access,
            invited,
            invitedBy,
        },
    }
}

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

export type CashReferralManagerWriteRefusalV1 =
    | 'invalid_request'
    | CashStaffAuthorityRefusalV1
    | 'person_changed'
    | 'busy'

type CurrentPersonV1 = { contactId: string; lineage: readonly string[]; lineageDigest: string }

/** The person a screen named, only if Contacts still names them so. */
async function currentPersonV1(port: CashReferralManagerPortV1, contactId: unknown): Promise<CurrentPersonV1 | null> {
    if (typeof contactId !== 'string' || contactId.trim() === '') return null
    const read = await port.resolveLineage(contactId)
    if (read.status !== 'resolved' || read.canonicalContactId !== contactId) return null
    return { contactId, lineage: read.contactIds, lineageDigest: compensationLineageDigestV1(read.contactIds) }
}

function admitV1(port: CashReferralManagerPortV1, authority: CashStaffAuthorityV1, purpose: CashStaffPurposeV1, requestId: unknown):
    | { ok: true; requestId: string }
    | { ok: false; refusal: CashReferralManagerWriteRefusalV1 } {
    if (!cashReferralRequestIdValidV1(requestId)) return { ok: false, refusal: 'invalid_request' }
    const admitted = cashStaffAuthorityForV1(authority, purpose, port.now())
    if (!admitted.admitted) return { ok: false, refusal: admitted.refusal }
    return { ok: true, requestId }
}

export type CashReferralRecordResultV1 =
    | { status: 'recorded' | 'already_recorded'; attributionId: string }
    | { status: 'refused'; reason: CashReferralManagerWriteRefusalV1 | 'self_invitation' }
    | { status: 'refused'; reason: 'invitee_already_attributed'; inviterContactId: string; inviterName: string | null }

/** Records that one person invited another. Grants nothing. */
export async function recordCashReferralInvitationV1(port: CashReferralManagerPortV1, input: {
    inviterContactId: unknown
    inviteeContactId: unknown
    comment: string | null
    requestId: unknown
    authority: CashStaffAuthorityV1
}): Promise<CashReferralRecordResultV1> {
    const admitted = admitV1(port, input.authority, 'invitation', input.requestId)
    if (!admitted.ok) return { status: 'refused', reason: admitted.refusal }
    const inviter = await currentPersonV1(port, input.inviterContactId)
    const invitee = await currentPersonV1(port, input.inviteeContactId)
    if (inviter === null || invitee === null) return { status: 'refused', reason: 'person_changed' }

    const profiles = await port.profilesOfContacts([...inviter.lineage, ...invitee.lineage])
    const licencesOf = (person: CurrentPersonV1) => [...new Set(profiles
        .filter((profile) => profile.contactId !== null && person.lineage.includes(profile.contactId))
        .map((profile) => cashReferralLicenceKeyV1(profile.licenseNumber))
        .filter((key): key is string => key !== null))]

    for (let attempt = 0; attempt < 2; attempt += 1) {
        const inviteeInvitations = (await port.listInvitationsOfContacts(invitee.lineage))
            .filter((row) => row.inviteeContactId !== null && invitee.lineage.includes(row.inviteeContactId))
        const decision = decideCashReferralLinkV1({
            inviter: { contactId: inviter.contactId, lineage: inviter.lineage, licenceKeys: licencesOf(inviter) },
            invitee: { contactId: invitee.contactId, lineage: invitee.lineage, licenceKeys: licencesOf(invitee) },
            inviteeInvitations,
        })
        if (decision.outcome === 'already_recorded') return { status: 'already_recorded', attributionId: decision.attributionId }
        if (decision.outcome === 'refused') {
            if (decision.reason === 'self_invitation') return { status: 'refused', reason: 'self_invitation' }
            const owner = await port.profilesOfContacts([decision.inviterContactId])
            return {
                status: 'refused',
                reason: 'invitee_already_attributed',
                inviterContactId: decision.inviterContactId,
                inviterName: cashReferralDisplayNameV1(owner),
            }
        }
        const written = await port.recordManagerInvitation({
            inviterContactId: inviter.contactId,
            inviterLineageDigest: inviter.lineageDigest,
            inviteeContactId: invitee.contactId,
            inviteeLineage: invitee.lineage,
            actor: cashStaffActorV1(input.authority, 'invitation'),
            reason: cashReferralLinkReasonV1(input.comment),
            payload: { operatorLabel: input.authority.operatorLabel },
            idempotencyKey: `manager:invitation:${admitted.requestId}`,
        })
        if (written.outcome === 'recorded' || written.outcome === 'already_recorded') {
            return { status: written.outcome, attributionId: written.attributionId }
        }
        // A conflict or a moved chain: someone wrote meanwhile; decide again on what is there now.
    }
    return { status: 'refused', reason: 'busy' }
}

export type CashReferralWithdrawResultV1 =
    | { status: 'withdrawn' | 'already_withdrawn' }
    | { status: 'refused'; reason: CashReferralManagerWriteRefusalV1 | 'not_withdrawable' }

/** Takes back a manager's invitation record. Access granted for it is a separate decision and stays. */
export async function withdrawCashReferralInvitationV1(port: CashReferralManagerPortV1, input: {
    attributionId: unknown
    expectedVersion: unknown
    comment: string | null
    requestId: unknown
    authority: CashStaffAuthorityV1
}): Promise<CashReferralWithdrawResultV1> {
    const admitted = admitV1(port, input.authority, 'invitation', input.requestId)
    if (!admitted.ok) return { status: 'refused', reason: admitted.refusal }
    if (typeof input.attributionId !== 'string' || !Number.isInteger(input.expectedVersion)) return { status: 'refused', reason: 'invalid_request' }
    const row = await port.findInvitation(input.attributionId)
    if (row === null || row.source !== 'manager') return { status: 'refused', reason: 'not_withdrawable' }
    const written = await port.withdrawManagerInvitation({
        attributionId: row.attributionId,
        expectedVersion: input.expectedVersion as number,
        actor: cashStaffActorV1(input.authority, 'invitation'),
        reason: cashReferralWithdrawReasonV1(input.comment),
        payload: { operatorLabel: input.authority.operatorLabel },
        idempotencyKey: `manager:withdraw:${admitted.requestId}`,
    })
    if (written === 'withdrawn' || written === 'already_withdrawn') return { status: written }
    if (written === 'busy') return { status: 'refused', reason: 'busy' }
    // The record moved since the screen read it: withdrawn already, or changed.
    return { status: 'refused', reason: row.state === 'recorded' ? 'person_changed' : 'not_withdrawable' }
}

export type CashAccessGrantResultV1 =
    | { status: 'granted' | 'already_granted' }
    | { status: 'refused'; reason: CashReferralManagerWriteRefusalV1 | 'comment_required' | 'invitation_not_found' | 'person_merged' }

/** Grants a person perpetual Cash access. Needs no invitation; records nothing about one unless named. */
export async function grantCashAccessV1(port: CashReferralManagerPortV1, input: {
    contactId: unknown
    basis: CashAccessGrantBasisV1
    referralAttributionId: string | null
    comment: string | null
    requestId: unknown
    authority: CashStaffAuthorityV1
}): Promise<CashAccessGrantResultV1> {
    const admitted = admitV1(port, input.authority, 'access', input.requestId)
    if (!admitted.ok) return { status: 'refused', reason: admitted.refusal }
    const person = await currentPersonV1(port, input.contactId)
    if (person === null) return { status: 'refused', reason: 'person_changed' }
    const personInvitations = (await port.listInvitationsOfContacts(person.lineage))
        .filter((row) => person.lineage.includes(row.inviterContactId))
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const view = cashAccessManagerViewV1(await port.readChain(person.contactId), person.lineageDigest)
        const decision = decideCashAccessGrantV1({
            view,
            lineage: person.lineage,
            basis: input.basis,
            referralAttributionId: input.referralAttributionId,
            personInvitations,
            comment: input.comment,
            operatorLabel: input.authority.operatorLabel,
        })
        if (decision.outcome === 'already_granted') return { status: 'already_granted' }
        if (decision.outcome === 'refused') return { status: 'refused', reason: decision.reason }
        const written = await port.appendManagerAccessEvents([{
            chainContactId: person.contactId,
            kind: 'manual_granted',
            lineageDigest: person.lineageDigest,
            codeHash: null,
            attributionId: null,
            payload: decision.payload,
            actor: cashStaffActorV1(input.authority, 'access'),
            reason: decision.reason,
            idempotencyKey: `manager:grant:${admitted.requestId}`,
        }])
        if (written === 'written') return { status: 'granted' }
        if (written === 'already_written') return { status: 'already_granted' }
    }
    return { status: 'refused', reason: 'busy' }
}

export type CashAccessRevokeResultV1 =
    | { status: 'revoked' | 'nothing_to_revoke' }
    | { status: 'refused'; reason: CashReferralManagerWriteRefusalV1 }

/** Takes back every standing grant of a person. The standard programme is untouched. */
export async function revokeCashAccessV1(port: CashReferralManagerPortV1, input: {
    contactId: unknown
    comment: string | null
    requestId: unknown
    authority: CashStaffAuthorityV1
}): Promise<CashAccessRevokeResultV1> {
    const admitted = admitV1(port, input.authority, 'access', input.requestId)
    if (!admitted.ok) return { status: 'refused', reason: admitted.refusal }
    const person = await currentPersonV1(port, input.contactId)
    if (person === null) return { status: 'refused', reason: 'person_changed' }
    const key = `manager:revoke:${admitted.requestId}`
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const chain = await port.readChain(person.contactId)
        // A retry of a revoke that was written already answers as it did.
        if (chain.some((event) => event.idempotencyKey === key || event.idempotencyKey === `${key}:entitlement`)) return { status: 'revoked' }
        const view = cashAccessManagerViewV1(chain, person.lineageDigest)
        const decision = decideCashAccessRevokeV1({ view, comment: input.comment, operatorLabel: input.authority.operatorLabel })
        if (decision.outcome === 'nothing_to_revoke') return { status: 'nothing_to_revoke' }
        const actor = cashStaffActorV1(input.authority, 'access')
        const base = {
            chainContactId: person.contactId,
            lineageDigest: person.lineageDigest,
            codeHash: null,
            payload: decision.payload,
            actor,
            reason: decision.reason,
        }
        const drafts: CashAccessEventDraftV1[] = []
        if (decision.clearManual) {
            drafts.push({ ...base, kind: 'manual_cleared', attributionId: null, idempotencyKey: key })
        }
        if (decision.revokeEntitlementOf !== null) {
            drafts.push({
                ...base,
                kind: 'referral_entitlement_revoked',
                attributionId: decision.revokeEntitlementOf,
                idempotencyKey: decision.clearManual ? `${key}:entitlement` : key,
            })
        }
        const written = await port.appendManagerAccessEvents(drafts)
        if (written === 'written' || written === 'already_written') return { status: 'revoked' }
    }
    return { status: 'refused', reason: 'busy' }
}
