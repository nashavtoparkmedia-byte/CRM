/**
 * Runtime execution of the Telegram-attested phone decision.
 *
 * The decision itself lives in telegram-attested-phone.ts and stays pure. This
 * is the part that touches the world: it gathers the snapshot the decision
 * needs, asks for a verdict, and performs exactly the one action that verdict
 * names. Nothing here re-derives identity, so the rules cannot drift between
 * the decision and what actually happens.
 *
 * Every action is idempotent. Attaching a phone the contact already owns, or
 * merging a pair already merged, is a no-op rather than a second row, so a
 * retried bot callback cannot split one person into two.
 */

import {
    decideTelegramAttestedPhoneV1,
    type TelegramAttestedPhoneDecisionV1,
    type TelegramPhoneAttestationV1,
} from './telegram-attested-phone'

export interface TelegramIdentityRepairPortV1 {
    /**
     * Runs the body inside one transaction. The merge it calls takes its own
     * ordered contact-pair lock, so no extra ordering is imposed here.
     */
    runInTransaction<T>(body: () => Promise<T>): Promise<T>
    normalizePhone(raw: string): string | null
    /** Active telegram identity for this account, or null. */
    findTelegramIdentity(telegramUserId: string): Promise<{
        identityId: string
        contactId: string
        isActive: boolean
    } | null>
    /** Canonical contacts owning this exact normalized phone. */
    findPhoneOwners(normalizedPhone: string): Promise<readonly string[]>
    /**
     * A contact is bare when a bot interaction is all that created it: no
     * phone of its own, no Yandex driver, no driver profile pointing at it.
     */
    isContactBare(contactId: string): Promise<boolean>
    /** Idempotent: does nothing when the contact already owns the phone. */
    attachPhoneToContact(input: { contactId: string; normalizedPhone: string; attestedAt: Date }): Promise<void>
    /** Idempotent: does nothing when the identity already sits on the contact. */
    attachTelegramIdentityToContact(input: {
        contactId: string
        telegramUserId: string
        attestedAt: Date
    }): Promise<void>
    /** The existing contact-to-contact merge. Replay returns already_merged. */
    mergeContactIntoContact(input: {
        sourceContactId: string
        survivorContactId: string
        mergedBy: string
    }): Promise<void>
    /** Durable record of anything a human must look at. */
    recordManualReview(input: {
        telegramUserId: string
        normalizedPhone: string | null
        reason: string
        identityContactId: string | null
        candidateContactIds: readonly string[]
        observedAt: Date
    }): Promise<void>
}

export interface TelegramIdentityRepairResultV1 {
    decision: TelegramAttestedPhoneDecisionV1
    /** The canonical contact the Telegram account resolves to afterwards. */
    canonicalContactId: string | null
    applied: boolean
}

export async function repairTelegramIdentityFromAttestationV1(
    attestation: TelegramPhoneAttestationV1,
    port: TelegramIdentityRepairPortV1,
    mergedBy = 'telegram_attested_phone',
): Promise<TelegramIdentityRepairResultV1> {
    return port.runInTransaction(async () => {
        // Read the world once, inside the transaction, so the verdict cannot be
        // made against a snapshot that changed before it was applied.
        const identityRow = await port.findTelegramIdentity(attestation.telegramUserId)
        const normalized = port.normalizePhone(attestation.rawPhone)
        const owners = normalized ? await port.findPhoneOwners(normalized) : []
        const identity = identityRow === null
            ? null
            : {
                identityId: identityRow.identityId,
                contactId: identityRow.contactId,
                isActive: identityRow.isActive,
                contactIsBare: await port.isContactBare(identityRow.contactId),
            }

        const decision = decideTelegramAttestedPhoneV1({
            attestation,
            identity,
            phoneOwnership: { contactIds: owners },
            normalizePhone: port.normalizePhone,
        })

        switch (decision.kind) {
            case 'attach_phone_to_identity_contact':
                await port.attachPhoneToContact({
                    contactId: decision.contactId,
                    normalizedPhone: decision.normalizedPhone,
                    attestedAt: attestation.observedAt,
                })
                return { decision, canonicalContactId: decision.contactId, applied: true }

            case 'confirm_existing_binding':
                // The phone is already on this contact and the identity already
                // sits there. Writing anything would only add noise.
                return { decision, canonicalContactId: decision.contactId, applied: false }

            case 'merge_identity_contact_into_phone_owner':
                await port.mergeContactIntoContact({
                    sourceContactId: decision.sourceContactId,
                    survivorContactId: decision.survivorContactId,
                    mergedBy,
                })
                return { decision, canonicalContactId: decision.survivorContactId, applied: true }

            case 'attach_identity_to_phone_owner':
                await port.attachTelegramIdentityToContact({
                    contactId: decision.contactId,
                    telegramUserId: attestation.telegramUserId,
                    attestedAt: attestation.observedAt,
                })
                return { decision, canonicalContactId: decision.contactId, applied: true }

            case 'manual_review':
                await port.recordManualReview({
                    telegramUserId: attestation.telegramUserId,
                    normalizedPhone: decision.normalizedPhone,
                    reason: decision.reason,
                    identityContactId: decision.identityContactId,
                    candidateContactIds: decision.candidateContactIds,
                    observedAt: attestation.observedAt,
                })
                return { decision, canonicalContactId: null, applied: false }

            case 'fail_closed':
                await port.recordManualReview({
                    telegramUserId: attestation.telegramUserId,
                    normalizedPhone: normalized,
                    reason: decision.reason,
                    identityContactId: identity?.contactId ?? null,
                    candidateContactIds: decision.candidateContactIds,
                    observedAt: attestation.observedAt,
                })
                return { decision, canonicalContactId: null, applied: false }
        }
    })
}
