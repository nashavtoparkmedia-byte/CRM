/**
 * Telegram-attested phone evidence, turned into one explicit identity decision.
 *
 * Telegram itself attests the phone: the share button returns a contact whose
 * `user_id` is the sharing account when, and only when, the number belongs to
 * that account. The bot already refuses a forwarded card. This module is the
 * part that was missing — it decides what that proof is allowed to change.
 *
 * The canonical model is one person, one canonical contact, many channel
 * identities, many Yandex driver profiles. A phone therefore never gets copied
 * onto a second contact to make a link work: a phone that already belongs to a
 * canonical contact is evidence that the contact IS that person, so the bare
 * auto-created Telegram contact is the duplicate and is merged away.
 *
 * Every branch is exact. There is no scoring, no fuzzy matching, and names are
 * never evidence. Anything the rules do not prove fails closed.
 */

export const TELEGRAM_ATTESTED_PHONE_DECISIONS_V1 = [
    'attach_phone_to_identity_contact',
    'confirm_existing_binding',
    'merge_identity_contact_into_phone_owner',
    'attach_identity_to_phone_owner',
    'manual_review',
    'fail_closed',
] as const

export type TelegramAttestedPhoneDecisionKindV1 =
    typeof TELEGRAM_ATTESTED_PHONE_DECISIONS_V1[number]

export const TELEGRAM_ATTESTED_PHONE_REASONS_V1 = [
    'ownership_not_proven',
    'phone_unparseable',
    'phone_owned_by_several_contacts',
    'identity_contact_is_not_bare',
    'no_identity_and_no_phone_owner',
    'identity_inactive',
] as const

export type TelegramAttestedPhoneReasonV1 =
    typeof TELEGRAM_ATTESTED_PHONE_REASONS_V1[number]

/** What the bot observed in the current session. */
export interface TelegramPhoneAttestationV1 {
    /** Telegram id of the account that sent the message. */
    telegramUserId: string
    /** `contact.user_id` from the shared card; null when Telegram omitted it. */
    sharedContactUserId: string | null
    /** Phone exactly as Telegram delivered it. */
    rawPhone: string
    observedAt: Date
}

/** The Telegram channel identity currently on record, if any. */
export interface TelegramIdentitySnapshotV1 {
    identityId: string
    contactId: string
    isActive: boolean
    /**
     * True when the contact carries no phone and no Yandex driver of its own,
     * i.e. it is the bare record a bot interaction creates.
     */
    contactIsBare: boolean
}

/** Canonical contacts that already own the attested phone. */
export interface PhoneOwnershipSnapshotV1 {
    /** Contact ids owning the normalized phone. Order is irrelevant. */
    contactIds: readonly string[]
}

export type TelegramAttestedPhoneDecisionV1 =
    | {
        kind: 'attach_phone_to_identity_contact'
        normalizedPhone: string
        contactId: string
        identityId: string
    }
    | {
        kind: 'confirm_existing_binding'
        normalizedPhone: string
        contactId: string
        identityId: string
    }
    | {
        kind: 'merge_identity_contact_into_phone_owner'
        normalizedPhone: string
        /** The bare Telegram contact that must not survive. */
        sourceContactId: string
        /** The canonical contact that already owns the phone. */
        survivorContactId: string
        identityId: string
    }
    | {
        kind: 'attach_identity_to_phone_owner'
        normalizedPhone: string
        contactId: string
    }
    | {
        kind: 'manual_review'
        normalizedPhone: string
        reason: TelegramAttestedPhoneReasonV1
        identityContactId: string | null
        candidateContactIds: readonly string[]
    }
    | {
        kind: 'fail_closed'
        reason: TelegramAttestedPhoneReasonV1
        candidateContactIds: readonly string[]
    }

export interface TelegramAttestedPhoneInputV1 {
    attestation: TelegramPhoneAttestationV1
    identity: TelegramIdentitySnapshotV1 | null
    phoneOwnership: PhoneOwnershipSnapshotV1
    /** Injected so the decision stays pure and the repository keeps one parser. */
    normalizePhone: (raw: string) => string | null
}

/**
 * Telegram proves the number belongs to the sending account only when the
 * shared card carries that account's own id. A missing id is not weaker
 * evidence, it is no evidence.
 */
export function telegramOwnershipProvenV1(attestation: TelegramPhoneAttestationV1): boolean {
    const shared = attestation.sharedContactUserId
    if (shared === null || shared === undefined || shared === '') return false
    return String(shared) === String(attestation.telegramUserId)
}

export function decideTelegramAttestedPhoneV1(
    input: TelegramAttestedPhoneInputV1,
): TelegramAttestedPhoneDecisionV1 {
    const { attestation, identity, phoneOwnership, normalizePhone } = input

    if (!telegramOwnershipProvenV1(attestation)) {
        return { kind: 'fail_closed', reason: 'ownership_not_proven', candidateContactIds: [] }
    }

    const normalizedPhone = normalizePhone(attestation.rawPhone)
    if (!normalizedPhone) {
        return { kind: 'fail_closed', reason: 'phone_unparseable', candidateContactIds: [] }
    }

    // Distinct owners only: the same contact listed twice is still one person.
    const owners = [...new Set(phoneOwnership.contactIds)]

    // Case D. Two canonical people cannot both own one number. Never guess.
    if (owners.length > 1) {
        return {
            kind: 'fail_closed',
            reason: 'phone_owned_by_several_contacts',
            candidateContactIds: owners,
        }
    }

    // Case E. No channel identity on record.
    if (identity === null) {
        if (owners.length === 1) {
            return { kind: 'attach_identity_to_phone_owner', normalizedPhone, contactId: owners[0] }
        }
        return {
            kind: 'fail_closed',
            reason: 'no_identity_and_no_phone_owner',
            candidateContactIds: [],
        }
    }

    // An inactive identity is a deliberate detachment. Reviving it silently
    // would undo whoever detached it.
    if (!identity.isActive) {
        return {
            kind: 'manual_review',
            normalizedPhone,
            reason: 'identity_inactive',
            identityContactId: identity.contactId,
            candidateContactIds: owners,
        }
    }

    // Case A. Nobody owns the phone, so attaching it to the contact that
    // already holds this Telegram identity creates no second owner.
    if (owners.length === 0) {
        return {
            kind: 'attach_phone_to_identity_contact',
            normalizedPhone,
            contactId: identity.contactId,
            identityId: identity.identityId,
        }
    }

    // Case B. The one owner is the contact we are already on. Nothing moves.
    if (owners[0] === identity.contactId) {
        return {
            kind: 'confirm_existing_binding',
            normalizedPhone,
            contactId: identity.contactId,
            identityId: identity.identityId,
        }
    }

    // Case C. One other canonical contact owns the phone. Merging is safe only
    // when the Telegram-side contact is the bare record a bot tap created;
    // anything richer may be a real second person and goes to a human.
    if (!identity.contactIsBare) {
        return {
            kind: 'manual_review',
            normalizedPhone,
            reason: 'identity_contact_is_not_bare',
            identityContactId: identity.contactId,
            candidateContactIds: owners,
        }
    }

    return {
        kind: 'merge_identity_contact_into_phone_owner',
        normalizedPhone,
        sourceContactId: identity.contactId,
        survivorContactId: owners[0],
        identityId: identity.identityId,
    }
}
