/**
 * Whether one captured invitation qualifies its inviter for referral Cash
 * access.
 *
 * Nothing calls this yet. It is the rule the referral flow will apply when an
 * invitation is checked; nothing is stored, granted or sent from here.
 *
 * An invitation qualifies when the invited person is proven, is a different
 * person from the inviter, is connected to the park as a park-SMZ, and joined
 * after the invitation was captured. A person already registered before that
 * qualifies only with a manager's sanction, made through a signed staff
 * session and naming this invitation. The sanction answers that one question
 * and nothing else: identity, self-referral, a second attribution and the
 * park-SMZ status are decided before it is read.
 *
 * Missing provider facts never refuse. An unknown SMZ status, hire date or
 * registration history leaves the invitation pending. A stated "not
 * self-employed" is "not qualified" rather than a final rejection, because
 * an invitation does not expire and is checked again later.
 *
 * A qualifying invitation confirms referral access at the instant of this
 * decision, so the inviter's access never reaches back before it. The
 * inviter's own SMZ status and connection date play no part.
 */

import { compensationBusinessDayKeyV1 } from './compensation-calendar'
import type { CashAccessActorV1, CashAccessIdentityRefusalV1 } from './compensation-access'

/** What a signed staff session must hold to sanction a referral for an already registered person. */
export const CASH_REFERRAL_QUALIFY_CAPABILITY_V1 = 'cash.referral.qualify'

/** One invitation as it was captured: who shared the link and which Telegram account opened it. */
export interface CashReferralCaptureV1 {
    attributionId: string
    capturedAt: Date
    inviterContactId: string
    inviterTelegramUserId: string
    inviteeTelegramUserId: string
}

/** A person as the Contacts proof gives it now. */
export type CashReferralPersonV1 =
    | { proven: false; refusal: 'not_linked' | CashAccessIdentityRefusalV1 }
    | {
        proven: true
        /** The canonical contact proven for this person. */
        contactId: string
        /** Every contact that canonical contact stands for. */
        lineage: readonly string[]
        /** The confirmed person key of the proven Driver profile, when the park states one. */
        externalPersonKey: string | null
    }

/** What the provider states about the invited person's proven profile. */
export interface CashReferralInviteeFactsV1 {
    /** `driver_profile.is_selfemployed`; null when the park never stated it. */
    isSelfEmployed: boolean | null
    /** `driver_profile.hire_date`; null when the park never stated it. */
    parkHireDate: Date | null
    dismissedAt: Date | null
    /**
     * Whether another profile of the same person, in any park, was registered
     * before the invitation was captured. Null when that history is unknown.
     */
    otherProfileRegisteredBeforeCapture: boolean | null
}

/** A manager's sanction to qualify an invitation of an already registered person. */
export interface CashReferralSanctionV1 {
    attributionId: string
    sanctionedAt: Date
    actor: CashAccessActorV1
}

export interface CashReferralQualificationInputV1 {
    capture: CashReferralCaptureV1
    inviter: CashReferralPersonV1
    invitee: CashReferralPersonV1
    /** Null when the provider could not confirm the invitee's profile now. */
    inviteeFacts: CashReferralInviteeFactsV1 | null
    /** The two people share a phone number. A phone can only ever block, never qualify. */
    sharedPhone: boolean
    /** Another invitation has already qualified for this invited person. */
    inviteeAlreadyAttributed: boolean
    /** The inviter already holds standing referral access. */
    inviterAlreadyEntitled: boolean
    sanction: CashReferralSanctionV1 | null
    /** The database clock the decision is taken at. */
    at: Date
}

export const CASH_REFERRAL_PENDING_REASONS_V1 = [
    'inviter_identity_blocked',
    'invitee_not_linked',
    'invitee_identity_blocked',
    'invitee_facts_unavailable',
    'invitee_smz_unknown',
    'invitee_hire_date_unknown',
    'invitee_registration_history_unknown',
] as const

export type CashReferralPendingReasonV1 = typeof CASH_REFERRAL_PENDING_REASONS_V1[number]

/** Why a sanction present in the input took no part in the decision. */
export type CashReferralIgnoredSanctionV1 =
    | 'sanction_unsigned'
    | 'sanction_missing_capability'
    | 'sanction_other_invitation'
    | 'sanction_not_yet_effective'

export type CashReferralQualificationV1 =
    | {
        outcome: 'qualified'
        via: 'new_park_smz' | 'manager_sanction'
        /** `already_entitled`: recorded, but the inviter gets no second grant. */
        grant: 'grant' | 'already_entitled'
        /** The instant referral access starts; never earlier than this decision. */
        confirmedAt: Date
        ignored: readonly CashReferralIgnoredSanctionV1[]
    }
    | { outcome: 'pending'; reason: CashReferralPendingReasonV1; ignored: readonly CashReferralIgnoredSanctionV1[] }
    | {
        outcome: 'requires_manager_qualification'
        reason: 'invitee_registered_before_invitation'
        ignored: readonly CashReferralIgnoredSanctionV1[]
    }
    | {
        /** Checked again later: nothing about the invitation is final. */
        outcome: 'not_qualified'
        reason: 'invitee_not_park_smz' | 'invitee_not_connected'
        ignored: readonly CashReferralIgnoredSanctionV1[]
    }
    | {
        outcome: 'rejected'
        reason: 'self_referral' | 'self_referral_suspected' | 'invitee_already_attributed'
        ignored: readonly CashReferralIgnoredSanctionV1[]
    }

/** The sanction, only when a signed staff session with the capability made it for this invitation. */
function authorisedSanctionV1(
    sanction: CashReferralSanctionV1 | null,
    attributionId: string,
    at: Date,
    ignored: CashReferralIgnoredSanctionV1[],
): CashReferralSanctionV1 | null {
    if (sanction === null) return null
    const actor = sanction.actor
    if (actor.kind !== 'signed_staff_session' || actor.principalId.trim() === '') {
        ignored.push('sanction_unsigned')
        return null
    }
    if (!actor.capabilities.includes(CASH_REFERRAL_QUALIFY_CAPABILITY_V1)) {
        ignored.push('sanction_missing_capability')
        return null
    }
    if (sanction.attributionId !== attributionId) {
        ignored.push('sanction_other_invitation')
        return null
    }
    if (sanction.sanctionedAt.getTime() > at.getTime()) {
        ignored.push('sanction_not_yet_effective')
        return null
    }
    return sanction
}

/** The same human by any proof Contacts or the park gives: contact, merged lineage or person key. */
function samePersonV1(
    inviter: Extract<CashReferralPersonV1, { proven: true }>,
    invitee: Extract<CashReferralPersonV1, { proven: true }>,
): boolean {
    const inviterContacts = new Set([inviter.contactId, ...inviter.lineage])
    if ([invitee.contactId, ...invitee.lineage].some((contactId) => inviterContacts.has(contactId))) return true
    return inviter.externalPersonKey !== null && inviter.externalPersonKey === invitee.externalPersonKey
}

/**
 * Decides one invitation at one instant.
 *
 * Deterministic: the result depends on the input alone, and the input is
 * never modified. The age of the capture is never read.
 */
export function decideCashReferralQualificationV1(
    input: CashReferralQualificationInputV1,
): CashReferralQualificationV1 {
    const ignored: CashReferralIgnoredSanctionV1[] = []
    const sanction = authorisedSanctionV1(input.sanction, input.capture.attributionId, input.at, ignored)
    const { capture, inviter, invitee } = input

    if (capture.inviteeTelegramUserId === capture.inviterTelegramUserId) {
        return { outcome: 'rejected', reason: 'self_referral', ignored }
    }
    // The inviter's access is bound to the contact that shared the link. A
    // merge or a lost proof since then holds the invitation; it voids nothing.
    if (!inviter.proven || inviter.contactId !== capture.inviterContactId) {
        return { outcome: 'pending', reason: 'inviter_identity_blocked', ignored }
    }
    if (!invitee.proven) {
        return {
            outcome: 'pending',
            reason: invitee.refusal === 'not_linked' ? 'invitee_not_linked' : 'invitee_identity_blocked',
            ignored,
        }
    }
    if (samePersonV1(inviter, invitee)) return { outcome: 'rejected', reason: 'self_referral', ignored }
    if (input.sharedPhone) return { outcome: 'rejected', reason: 'self_referral_suspected', ignored }
    if (input.inviteeAlreadyAttributed) return { outcome: 'rejected', reason: 'invitee_already_attributed', ignored }

    const facts = input.inviteeFacts
    if (facts === null) return { outcome: 'pending', reason: 'invitee_facts_unavailable', ignored }
    if (facts.dismissedAt !== null && facts.dismissedAt.getTime() <= input.at.getTime()) {
        return { outcome: 'not_qualified', reason: 'invitee_not_connected', ignored }
    }
    if (facts.isSelfEmployed === null) return { outcome: 'pending', reason: 'invitee_smz_unknown', ignored }
    if (!facts.isSelfEmployed) return { outcome: 'not_qualified', reason: 'invitee_not_park_smz', ignored }
    if (facts.parkHireDate === null) return { outcome: 'pending', reason: 'invitee_hire_date_unknown', ignored }

    const qualified = (via: 'new_park_smz' | 'manager_sanction'): CashReferralQualificationV1 => ({
        outcome: 'qualified',
        via,
        grant: input.inviterAlreadyEntitled ? 'already_entitled' : 'grant',
        confirmedAt: input.at,
        ignored,
    })

    // Joined on the capture's business day or later, on the monetary core's
    // own calendar, so a same-day hire after the link counts as new.
    const joinedAfterCapture = compensationBusinessDayKeyV1(facts.parkHireDate)
        >= compensationBusinessDayKeyV1(capture.capturedAt)
    const registeredBefore = !joinedAfterCapture || facts.otherProfileRegisteredBeforeCapture === true
    if (!registeredBefore && facts.otherProfileRegisteredBeforeCapture === false) return qualified('new_park_smz')
    if (sanction !== null) return qualified('manager_sanction')
    if (registeredBefore) {
        return { outcome: 'requires_manager_qualification', reason: 'invitee_registered_before_invitation', ignored }
    }
    return { outcome: 'pending', reason: 'invitee_registration_history_unknown', ignored }
}
