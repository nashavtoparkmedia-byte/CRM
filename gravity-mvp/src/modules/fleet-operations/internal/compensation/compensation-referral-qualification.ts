/**
 * Whether one captured invitation qualifies its inviter for referral Cash
 * access.
 *
 * Nothing calls this yet. It is the rule the referral flow will apply when an
 * invitation is checked; nothing is stored, granted or sent from here.
 *
 * An invitation qualifies when the invited person is proven, is a different
 * person from the inviter, is connected to the target park as a park-SMZ now,
 * and was not connected to that park when the invitation was captured. The
 * target park is the park of the invited person's proven profile. A profile in
 * another park is not a registration in the target park and plays no part.
 *
 * Not connected at the capture means one of two things the fleet can show:
 *
 *   new       no profile of the person in the target park was registered
 *             before the capture's business day
 *   returned  every such earlier profile had been dismissed before the
 *             capture, as a fleet reading made at or after the capture states
 *
 * A registration in the target park is never a refusal by itself, and no
 * length of absence is read: the capture instant is the only clock. A reading
 * from before the capture proves nothing about the capture, because the
 * profile may have been restored in between. A driver whose earlier profile
 * is not shown to have ended before the capture may be working there still,
 * so the invitation needs a review: a manager's sanction, made through a
 * signed staff session and naming this invitation. The sanction answers that
 * one question and nothing else: identity, self-referral, a second
 * attribution and the park-SMZ status are decided before it is read.
 *
 * A phone the two people share proves neither that they are one person nor
 * that they are two, so it neither qualifies nor rejects: the invitation
 * goes to a manager, and only a signed sanction qualifies it.
 *
 * Missing provider facts never refuse, and never qualify on their own. An
 * unknown SMZ status, hire date or target-park registration history, or an
 * earlier profile not read since the capture, leaves the invitation pending.
 * A stated "not self-employed" is "not qualified" rather than a final
 * rejection, because an invitation does not expire and is checked again later.
 *
 * Only the inviter's access is decided here. The invited person gains nothing
 * from the invitation: their own Cash access is the standard programme's,
 * unchanged, and a returned driver is never given a first month by it.
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

/** A fleet reading that showed a profile dismissed. */
export interface CashReferralDismissalReadingV1 {
    /**
     * The latest instant the profile's latest dismissal can have happened, as
     * the reading states it. A reading that states only a date gives the end of
     * that date; see cashReferralDismissalReadingFromYandexV1.
     */
    dismissedAt: Date
    /** When the fleet made the reading. */
    readAt: Date
}

/** The two fields of one Yandex profile read that may show a dismissal. */
export interface YandexProfileDismissalFactsV1 {
    /** `profile.work_status` as read: working, not_working or fired. */
    workStatus: string | null
    /** `profile.fire_date` as read: a calendar date without a time or zone. */
    fireDate: string | null
    /** When the read was made. */
    readAt: Date
}

/**
 * The dismissal reading one Yandex profile read gives, or null when it proves
 * nothing.
 *
 * Only `work_status` fired with a valid `fire_date` counts. The date carries
 * no time or zone, so the dismissal is placed at the latest instant any zone
 * is still on that date, 12:00 UTC the next day: a dismissal dated the day of
 * the capture, or the day before it, never proves the driver had left by the
 * capture. The driver's online status (`current_status`) and the time it last
 * changed are not a dismissal, so they are not accepted here at all.
 */
export function cashReferralDismissalReadingFromYandexV1(read: YandexProfileDismissalFactsV1): CashReferralDismissalReadingV1 | null {
    if (read.workStatus !== 'fired' || read.fireDate === null) return null
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T[^\s]*)?$/.exec(read.fireDate)
    if (match === null) return null
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
    const date = new Date(Date.UTC(year, month - 1, day))
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
    return { dismissedAt: new Date(Date.UTC(year, month - 1, day + 1, 12)), readAt: read.readAt }
}

/** Another Driver profile of the same person, in any park. */
export interface CashReferralOtherProfileV1 {
    parkId: string
    /** When the park registered that profile (`driver_profile.hire_date`); null when it never stated it. */
    registeredAt: Date | null
    /** When the fleet last read this profile; null when it never did. */
    readAt: Date | null
    /** Every kept reading that showed this profile dismissed, the latest reading included when it did. */
    dismissals: readonly CashReferralDismissalReadingV1[]
}

/** What the provider states about the invited person's proven profile. */
export interface CashReferralInviteeFactsV1 {
    /** The park the invitation is for: the park of the invited person's proven profile. */
    targetParkId: string
    /** `driver_profile.is_selfemployed`; null when the park never stated it. */
    isSelfEmployed: boolean | null
    /** `driver_profile.hire_date`; null when the park never stated it. */
    parkHireDate: Date | null
    dismissedAt: Date | null
    /**
     * Kept readings that showed the proven profile itself dismissed. They
     * matter only when that profile was registered before the capture and
     * has since been restored.
     */
    dismissals: readonly CashReferralDismissalReadingV1[]
    /**
     * Every other profile of the same person the provider knows of, in any
     * park, dismissed ones included. Null when that history is unknown. Only
     * the profiles in the target park are read.
     */
    otherProfiles: readonly CashReferralOtherProfileV1[] | null
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
    /** The two people share a phone number: a manager decides, a phone never qualifies or rejects. */
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
    'invitee_departure_unknown',
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
        via: 'new_park_smz' | 'returned_park_smz' | 'manager_sanction'
        /** `already_entitled`: recorded, but the inviter gets no second grant. */
        grant: 'grant' | 'already_entitled'
        /** The instant referral access starts; never earlier than this decision. */
        confirmedAt: Date
        ignored: readonly CashReferralIgnoredSanctionV1[]
    }
    | { outcome: 'pending'; reason: CashReferralPendingReasonV1; ignored: readonly CashReferralIgnoredSanctionV1[] }
    | {
        /**
         * Registered in the target park before the invitation and not shown to
         * have left it, or sharing a phone with the inviter.
         */
        outcome: 'needs_review'
        reason: 'invitee_departure_unproven' | 'invitee_shares_phone'
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
        reason: 'self_referral' | 'invitee_already_attributed'
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
    if (input.inviteeAlreadyAttributed) return { outcome: 'rejected', reason: 'invitee_already_attributed', ignored }

    const facts = input.inviteeFacts
    if (facts === null) return { outcome: 'pending', reason: 'invitee_facts_unavailable', ignored }
    if (facts.dismissedAt !== null && facts.dismissedAt.getTime() <= input.at.getTime()) {
        return { outcome: 'not_qualified', reason: 'invitee_not_connected', ignored }
    }
    if (facts.isSelfEmployed === null) return { outcome: 'pending', reason: 'invitee_smz_unknown', ignored }
    if (!facts.isSelfEmployed) return { outcome: 'not_qualified', reason: 'invitee_not_park_smz', ignored }
    if (facts.parkHireDate === null) return { outcome: 'pending', reason: 'invitee_hire_date_unknown', ignored }

    const qualified = (via: 'new_park_smz' | 'returned_park_smz' | 'manager_sanction'): CashReferralQualificationV1 => ({
        outcome: 'qualified',
        via,
        grant: input.inviterAlreadyEntitled ? 'already_entitled' : 'grant',
        confirmedAt: input.at,
        ignored,
    })

    if (input.sharedPhone) {
        return sanction !== null ? qualified('manager_sanction') : { outcome: 'needs_review', reason: 'invitee_shares_phone', ignored }
    }

    // Registered before the capture's business day, on the monetary core's
    // own calendar, so a same-day hire after the link counts as new.
    const capturedAt = capture.capturedAt.getTime()
    const captureDay = compensationBusinessDayKeyV1(capture.capturedAt)
    const beforeCapture = (registeredAt: Date) => compensationBusinessDayKeyV1(registeredAt) < captureDay
    // Dismissed before the capture and still dismissed when read at or after
    // it, so the profile was not connected at the capture itself.
    const endedBeforeCapture = (dismissals: readonly CashReferralDismissalReadingV1[]) => dismissals.some(
        (reading) => reading.dismissedAt.getTime() < capturedAt && reading.readAt.getTime() >= capturedAt,
    )
    // Only the target park's own history counts: a profile elsewhere is not a
    // registration in this park.
    const targetParkProfiles = facts.otherProfiles === null
        ? null
        : facts.otherProfiles.filter((profile) => profile.parkId === facts.targetParkId)

    // What each earlier registration in the target park shows about the
    // capture. The proven profile is connected now, so only a kept reading
    // can show it had ended before the capture.
    const earlier: Array<'ended' | 'unproven' | 'unread'> = []
    if (beforeCapture(facts.parkHireDate)) earlier.push(endedBeforeCapture(facts.dismissals) ? 'ended' : 'unproven')
    for (const profile of targetParkProfiles ?? []) {
        if (profile.registeredAt === null || !beforeCapture(profile.registeredAt)) continue
        if (endedBeforeCapture(profile.dismissals)) earlier.push('ended')
        else earlier.push(profile.readAt !== null && profile.readAt.getTime() >= capturedAt ? 'unproven' : 'unread')
    }
    const historyUnknown = targetParkProfiles === null || targetParkProfiles.some((profile) => profile.registeredAt === null)

    if (!historyUnknown && earlier.length === 0) return qualified('new_park_smz')
    if (!historyUnknown && earlier.every((state) => state === 'ended')) return qualified('returned_park_smz')
    if (sanction !== null) return qualified('manager_sanction')
    if (earlier.includes('unproven')) return { outcome: 'needs_review', reason: 'invitee_departure_unproven', ignored }
    if (historyUnknown) return { outcome: 'pending', reason: 'invitee_registration_history_unknown', ignored }
    return { outcome: 'pending', reason: 'invitee_departure_unknown', ignored }
}
