/**
 * Deciding captured referral invitations.
 *
 * One pass reads the invitations not yet decided for good, gathers what
 * Contacts and Fleet state about both people now, runs the S0 rule and
 * records the outcome in one unit with the ledger. Every read happens before
 * the write; the write re-checks the attribution's version, so a pass that
 * raced another one records nothing and the next pass decides again.
 *
 * Only facts the fleet holds for the invited person's proven profile, and
 * for that person's earlier profiles in the same park, are read:
 *
 *   connected now      fleetSource.workStatus of the proven row, never
 *                      Driver.dismissedAt, which no Fleet writer maintains
 *   registrations      yandexHireDate of each target-park row with the same
 *                      park person key
 *   departures         a successful Yandex profile read made now, after the
 *                      capture: fired with a stated fire_date, upper-bounded
 *                      to the end of that date; a skipped or failed read is
 *                      no read at all, so the invitation stays pending
 *   shared phone       a phone held by a Driver of each person
 *
 * The person key is stored only as its domain-separated digest. A decision
 * that changes nothing (the same state and reason, no new reading) writes
 * nothing, so an undecided invitation does not grow the ledger every pass.
 */

import { decideCashReferralQualificationV1, cashReferralDismissalReadingFromYandexV1, type CashReferralDismissalReadingV1, type CashReferralQualificationV1 } from './compensation-referral-qualification'
import {
    cashReferralPersonKeyDigestV1,
    foldCashAccessLedgerV1,
    keptCashReferralDismissalsV1,
    latestCashReferralSanctionV1,
    type CashAccessEventV1,
    type CashAccessJsonV1,
} from './compensation-referral-ledger'
import { compensationBusinessDayKeyV1 } from './compensation-calendar'
import { compensationLineageDigestV1, type PilotContactLineageReadV1 } from './compensation-pilot-lineage'

/** One Fleet profile of the invited person, as the fleet holds it now. */
export interface CashReferralFleetProfileV1 {
    /** `externalParkId:externalDriverProfileId`: never a licence number. */
    profileRef: string
    externalParkId: string
    externalDriverProfileId: string
    /** yandexHireDate; null when the park never stated it. */
    registeredAt: Date | null
}

/** What the fleet holds for the invited person's proven profile. */
export interface CashReferralInviteeFleetFactsV1 {
    proven: CashReferralFleetProfileV1
    isSelfEmployed: boolean | null
    /** fleetSource.workStatus: working, not_working or fired; null when never read. */
    workStatus: string | null
    /** The park's person key of the proven row; null when the park states none. */
    externalPersonKey: string | null
    /** Every other row with the same person key in the same park. Null when that cannot be read. */
    earlierProfiles: readonly CashReferralFleetProfileV1[] | null
}

/** One Yandex profile read: only the two fields a dismissal is proved by. */
export interface CashReferralYandexReadV1 {
    workStatus: string | null
    fireDate: string | null
    readAt: Date
}

/** An invitation as stored. */
export interface CashReferralAttributionV1 {
    id: string
    inviterContactId: string
    inviterLineageDigest: string
    inviteeTelegramUserId: string
    state: string
    reason: string | null
    capturedAt: Date
    version: number
}

export interface CashReferralDecisionPortV1 {
    findUndecided(limit: number): Promise<CashReferralAttributionV1[]>
    readChain(contactId: string): Promise<CashAccessEventV1[]>
    readAttributionEvents(attributionId: string): Promise<CashAccessEventV1[]>
    personAlreadyQualified(personKeyDigest: string, exceptAttributionId: string): Promise<boolean>
    writeDecision(write: {
        attributionId: string
        expectedVersion: number
        state: 'pending' | 'needs_review' | 'not_qualified' | 'qualified' | 'rejected'
        reason: string | null
        inviteeContactId: string | null
        inviteePersonKey: string | null
        targetParkId: string | null
        factsSnapshot: { [key: string]: CashAccessJsonV1 }
        decision: { [key: string]: CashAccessJsonV1 }
        grant: boolean
        observedDismissals: ReadonlyArray<{ profileKey: string; dismissedAt: Date; readAt: Date }>
        idempotencyKey: string
    }): Promise<'written' | 'version_conflict' | 'person_already_qualified'>
    resolveContactLineage(contactId: string): Promise<PilotContactLineageReadV1>
    /** The Driver the invited Telegram account is linked to, with its Contact. */
    findLinkedDriver(telegramUserId: string): Promise<{ driverId: string; contactId: string | null } | null>
    confirmMainDriver(contactId: string, driverId: string): Promise<'confirmed' | 'not_confirmed' | 'busy'>
    readInviteeFleetFacts(driverId: string): Promise<CashReferralInviteeFleetFactsV1 | null>
    /** The park person keys of a contact's Drivers. */
    personKeysOfContact(contactId: string): Promise<readonly string[]>
    contactsSharePhone(left: string, right: string): Promise<boolean>
    /** A bounded Yandex read of one profile; null when it was skipped or failed. */
    readYandexProfile(profile: CashReferralFleetProfileV1): Promise<CashReferralYandexReadV1 | null>
    /** The database clock. */
    now(): Promise<Date>
}

export type CashReferralPassOutcomeV1 = {
    examined: number
    written: number
    unchanged: number
    conflicts: number
    states: Record<string, number>
}

type DecidedV1 = {
    decision: CashReferralQualificationV1
    inviteeContactId: string | null
    inviteePersonKey: string | null
    targetParkId: string | null
    factsSnapshot: { [key: string]: CashAccessJsonV1 }
    observedDismissals: Array<{ profileKey: string; dismissedAt: Date; readAt: Date }>
}

function stateOfV1(decision: CashReferralQualificationV1): 'pending' | 'needs_review' | 'not_qualified' | 'qualified' | 'rejected' {
    return decision.outcome
}

function reasonOfV1(decision: CashReferralQualificationV1): string | null {
    return decision.outcome === 'qualified' ? decision.via : decision.reason
}

async function proveInviterV1(attribution: CashReferralAttributionV1, port: CashReferralDecisionPortV1) {
    const lineage = await port.resolveContactLineage(attribution.inviterContactId)
    if (lineage.status !== 'resolved') return { person: { proven: false as const, refusal: 'identity_needs_review' as const }, lineageDigest: null }
    // A merge since the link was shared holds the invitation: S0 reads the
    // contact that shared it against the canonical one now.
    return {
        person: {
            proven: true as const,
            contactId: lineage.canonicalContactId,
            lineage: lineage.contactIds,
            externalPersonKey: null as string | null,
        },
        lineageDigest: compensationLineageDigestV1(lineage.contactIds),
    }
}

/** Decides one invitation from what Contacts and Fleet state now. */
export async function decideCashReferralAttributionV1(
    attribution: CashReferralAttributionV1,
    port: CashReferralDecisionPortV1,
): Promise<DecidedV1> {
    const at = await port.now()
    const inviter = await proveInviterV1(attribution, port)
    const events = await port.readAttributionEvents(attribution.id)
    const kept = keptCashReferralDismissalsV1(events, attribution.id)
    const sanction = latestCashReferralSanctionV1(events, attribution.id)
    const capture = {
        attributionId: attribution.id,
        capturedAt: attribution.capturedAt,
        inviterContactId: attribution.inviterContactId,
        // The Telegram account that shared the link is not stored: a
        // self-referral is found by contact, lineage and person key instead.
        inviterTelegramUserId: `contact:${attribution.inviterContactId}`,
        inviteeTelegramUserId: attribution.inviteeTelegramUserId,
    }
    const undecided = (refusal: 'not_linked' | 'identity_needs_review' | 'identity_busy'): DecidedV1 => ({
        decision: decideCashReferralQualificationV1({
            capture, inviter: inviter.person, invitee: { proven: false, refusal }, inviteeFacts: null,
            sharedPhone: false, inviteeAlreadyAttributed: false, inviterAlreadyEntitled: false, sanction, at,
        }),
        inviteeContactId: null, inviteePersonKey: null, targetParkId: null, factsSnapshot: {}, observedDismissals: [],
    })

    const linked = await port.findLinkedDriver(attribution.inviteeTelegramUserId)
    if (linked === null || linked.contactId === null) return undecided('not_linked')
    const confirmation = await port.confirmMainDriver(linked.contactId, linked.driverId)
    if (confirmation === 'busy') return undecided('identity_busy')
    if (confirmation !== 'confirmed') return undecided('identity_needs_review')
    const inviteeLineage = await port.resolveContactLineage(linked.contactId)
    if (inviteeLineage.status !== 'resolved') return undecided('identity_needs_review')

    const fleet = await port.readInviteeFleetFacts(linked.driverId)
    const personKey = fleet?.externalPersonKey ?? null
    const inviteePerson = {
        proven: true as const,
        contactId: inviteeLineage.canonicalContactId,
        lineage: inviteeLineage.contactIds,
        externalPersonKey: personKey,
    }
    let inviterPerson = inviter.person
    if (inviterPerson.proven && personKey !== null) {
        const inviterKeys = await port.personKeysOfContact(inviterPerson.contactId)
        inviterPerson = { ...inviterPerson, externalPersonKey: inviterKeys.includes(personKey) ? personKey : inviterKeys[0] ?? null }
    }

    // Departures: a read made now, for each target-park profile registered
    // before the capture's business day, the proven one included.
    const captureDay = compensationBusinessDayKeyV1(attribution.capturedAt)
    const before = (profile: CashReferralFleetProfileV1) =>
        profile.registeredAt !== null && compensationBusinessDayKeyV1(profile.registeredAt) < captureDay
    const observedDismissals: DecidedV1['observedDismissals'] = []
    const readFor = async (profile: CashReferralFleetProfileV1) => {
        if (!before(profile)) return { readAt: null, dismissals: kept.get(profile.profileRef) ?? [] }
        const read = await port.readYandexProfile(profile)
        if (read === null) return { readAt: null, dismissals: kept.get(profile.profileRef) ?? [] }
        const reading = cashReferralDismissalReadingFromYandexV1(read)
        const dismissals: CashReferralDismissalReadingV1[] = [...(kept.get(profile.profileRef) ?? [])]
        if (reading !== null) {
            dismissals.push(reading)
            if (!dismissals.slice(0, -1).some((known) => known.dismissedAt.getTime() === reading.dismissedAt.getTime())) {
                observedDismissals.push({ profileKey: profile.profileRef, dismissedAt: reading.dismissedAt, readAt: reading.readAt })
            }
        }
        return { readAt: read.readAt, dismissals }
    }

    let inviteeFacts = null
    let snapshot: { [key: string]: CashAccessJsonV1 } = {}
    if (fleet !== null && fleet.workStatus !== null && personKey !== null) {
        const proven = await readFor(fleet.proven)
        const earlier = fleet.earlierProfiles === null ? null : await Promise.all(fleet.earlierProfiles.map(async (profile) => {
            const read = await readFor(profile)
            return { profile, ...read }
        }))
        inviteeFacts = {
            targetParkId: fleet.proven.externalParkId,
            isSelfEmployed: fleet.isSelfEmployed,
            parkHireDate: fleet.proven.registeredAt,
            // Only the fleet's own work status says whether the person is connected now.
            dismissedAt: fleet.workStatus === 'fired' ? at : null,
            dismissals: proven.dismissals,
            otherProfiles: earlier === null ? null : earlier.map((entry) => ({
                parkId: entry.profile.externalParkId,
                registeredAt: entry.profile.registeredAt,
                readAt: entry.readAt,
                dismissals: entry.dismissals,
            })),
        }
        snapshot = {
            targetParkId: fleet.proven.externalParkId,
            provenProfile: fleet.proven.profileRef,
            workStatus: fleet.workStatus,
            isSelfEmployed: fleet.isSelfEmployed,
            parkHireDate: fleet.proven.registeredAt?.toISOString() ?? null,
            earlierProfiles: earlier === null ? null : earlier.map((entry) => ({
                profile: entry.profile.profileRef,
                registeredAt: entry.profile.registeredAt?.toISOString() ?? null,
                readAt: entry.readAt?.toISOString() ?? null,
                dismissed: entry.dismissals.length > 0,
            })),
        }
    }

    const keyDigest = personKey === null ? null : cashReferralPersonKeyDigestV1(personKey)
    const inviterFold = inviterPerson.proven && inviter.lineageDigest !== null
        ? foldCashAccessLedgerV1(await port.readChain(inviterPerson.contactId), inviter.lineageDigest)
        : null
    const decision = decideCashReferralQualificationV1({
        capture,
        inviter: inviterPerson,
        invitee: inviteePerson,
        inviteeFacts,
        sharedPhone: inviterPerson.proven ? await port.contactsSharePhone(inviterPerson.contactId, inviteePerson.contactId) : false,
        inviteeAlreadyAttributed: keyDigest !== null && await port.personAlreadyQualified(keyDigest, attribution.id),
        inviterAlreadyEntitled: inviterFold !== null && inviterFold.referral !== null && inviterFold.referral.revokedAt === null,
        sanction,
        at,
    })
    return {
        decision,
        inviteeContactId: inviteePerson.contactId,
        inviteePersonKey: keyDigest,
        targetParkId: fleet?.proven.externalParkId ?? null,
        factsSnapshot: snapshot,
        observedDismissals,
    }
}

/** One pass over the invitations not yet decided for good. */
export async function runCashReferralDecisionPassV1(port: CashReferralDecisionPortV1, limit: number): Promise<CashReferralPassOutcomeV1> {
    const outcome: CashReferralPassOutcomeV1 = { examined: 0, written: 0, unchanged: 0, conflicts: 0, states: {} }
    for (const attribution of await port.findUndecided(limit)) {
        outcome.examined += 1
        const decided = await decideCashReferralAttributionV1(attribution, port)
        const state = stateOfV1(decided.decision)
        const reason = reasonOfV1(decided.decision)
        outcome.states[state] = (outcome.states[state] ?? 0) + 1
        if (state === attribution.state && reason === attribution.reason && decided.observedDismissals.length === 0) {
            outcome.unchanged += 1
            continue
        }
        // A qualified invitation must name the person it qualified; without a
        // key nothing is granted (the S0 rule already holds it pending).
        if (state === 'qualified' && decided.inviteePersonKey === null) {
            outcome.unchanged += 1
            continue
        }
        const written = await port.writeDecision({
            attributionId: attribution.id,
            expectedVersion: attribution.version,
            state,
            reason,
            inviteeContactId: decided.inviteeContactId,
            inviteePersonKey: decided.inviteePersonKey,
            targetParkId: decided.targetParkId,
            factsSnapshot: decided.factsSnapshot,
            decision: decided.decision.outcome === 'qualified'
                ? { outcome: 'qualified', via: decided.decision.via, grant: decided.decision.grant }
                : { outcome: decided.decision.outcome, reason: decided.decision.reason, ignored: [...decided.decision.ignored] },
            grant: decided.decision.outcome === 'qualified' && decided.decision.grant === 'grant',
            observedDismissals: decided.observedDismissals,
            idempotencyKey: `decision:${attribution.id}:${attribution.version}`,
        })
        if (written === 'written') outcome.written += 1
        else outcome.conflicts += 1
    }
    return outcome
}
