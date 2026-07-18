'use strict'

/**
 * Pure decision core for canonical Contact resolution before an AI call.
 * Dependencies are injected so the contract can be tested without Prisma.
 */
function createAiCallContactResolver(deps) {
    return async function resolveAiCallContact(input) {
        const requestedContactId = clean(input?.contactId)
        const driverId = clean(input?.driverId)
        const suppliedPhone = clean(input?.phoneNumber)

        if (!requestedContactId && !driverId && !suppliedPhone) {
            return { status: 'invalid_input', reason: 'contact_driver_or_phone_required' }
        }

        if (requestedContactId) {
            const contact = await deps.findContactById(requestedContactId)
            if (!contact) return { status: 'not_found', reason: 'contact_not_found' }

            const activePhones = Array.isArray(contact.phones) ? contact.phones : []
            const normalizedSupplied = suppliedPhone ? deps.normalizePhone(suppliedPhone) : null
            if (suppliedPhone && !normalizedSupplied) {
                return { status: 'invalid_input', reason: 'invalid_phone' }
            }

            const selectedPhone = normalizedSupplied
                ?? activePhones.find(phone => phone.isPrimary)?.phone
                ?? activePhones[0]?.phone
                ?? null
            if (!selectedPhone) return { status: 'not_found', reason: 'contact_has_no_active_phone' }

            const normalizedSelected = deps.normalizePhone(selectedPhone)
            if (!normalizedSelected) return { status: 'invalid_input', reason: 'invalid_phone' }

            if (normalizedSupplied) {
                const owned = activePhones.some(phone => deps.normalizePhone(phone.phone) === normalizedSupplied)
                if (!owned) return { status: 'conflict', reason: 'contact_phone_mismatch' }
            }

            return {
                status: 'resolved',
                source: 'explicit_contact',
                contactId: contact.id,
                driverId,
                phoneE164: normalizedSelected,
                displayName: contact.displayName ?? null,
                created: false,
            }
        }

        let driver = null
        if (driverId) {
            driver = await deps.findDriverById(driverId)
            if (!driver) return { status: 'not_found', reason: 'driver_not_found' }
        }

        const rawPhone = suppliedPhone ?? driver?.phone ?? null
        if (!rawPhone) return { status: 'not_found', reason: 'phone_not_found' }
        const phoneE164 = deps.normalizePhone(rawPhone)
        if (!phoneE164) return { status: 'invalid_input', reason: 'invalid_phone' }

        const matches = await deps.findContactsByPhone(phoneE164)
        const unique = new Map()
        for (const match of matches ?? []) {
            if (match?.contactId && !unique.has(match.contactId)) unique.set(match.contactId, match)
        }
        if (unique.size > 1) {
            return {
                status: 'ambiguous',
                reason: 'multiple_contacts_for_phone',
                phoneE164,
                candidateContactIds: [...unique.keys()].sort(),
            }
        }
        if (unique.size === 1) {
            const match = [...unique.values()][0]
            return {
                status: 'resolved',
                source: 'existing_phone',
                contactId: match.contactId,
                driverId,
                phoneE164,
                displayName: match.displayName ?? driver?.fullName ?? null,
                created: false,
            }
        }

        const canonical = await deps.resolveByPhone(phoneE164, driver?.fullName ?? null)
        if (!canonical?.contact?.id) {
            return { status: 'not_found', reason: 'canonical_resolution_failed', phoneE164 }
        }
        return {
            status: 'resolved',
            source: canonical.isNew ? 'canonical_created' : 'canonical_existing',
            contactId: canonical.contact.id,
            driverId,
            phoneE164,
            displayName: canonical.contact.displayName ?? driver?.fullName ?? null,
            created: canonical.isNew === true,
        }
    }
}

function clean(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

module.exports = { createAiCallContactResolver }
