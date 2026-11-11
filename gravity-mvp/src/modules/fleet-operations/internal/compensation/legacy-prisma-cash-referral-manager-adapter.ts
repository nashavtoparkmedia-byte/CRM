/**
 * Prisma reads for the Cash referral manager screens. Read-only.
 *
 * Profiles are Fleet's own Driver rows; park names come to the service from
 * the park metadata capability, never from a connection row read here. Who a
 * person is comes from Contacts through its public capabilities only: who a
 * name or a phone belongs to (ContactLookup.v1), a contact's lineage and its
 * confirmations. Contacts tables are never read here.
 *
 * Each statement below is written out in full, so the analyzer reads it end
 * to end as a read of one named table.
 */

import { prisma } from '@/lib/prisma'
import {
    contactOwnershipBusyResultV1,
    type ContactLookupRankClassV1,
    isContactConfirmedMainDriverV1,
    resolveContactLineageV1,
    searchContactsV1,
} from '@/modules/contacts/public/v1'

import {
    CASH_REFERRAL_FULL_LOOKUP_CLASSES_V1,
    cashReferralLookupFullMatchV1,
    type CashReferralLineageReadV1,
    type CashReferralManagerProfileV1,
} from './cash-referral-manager'

// The full-match classes Cash trusts must be classes ContactLookup.v1 declares; a rename there fails here.
CASH_REFERRAL_FULL_LOOKUP_CLASSES_V1 satisfies readonly ContactLookupRankClassV1[]

interface ProfileRow {
    id: string
    fullName: string | null
    phone: string | null
    licenseNumber: string | null
    externalParkId: string | null
    contactId: string | null
    dismissedAt: Date | null
    isSelfEmployed: boolean | null
    employmentType: string | null
}

function toProfileV1(row: ProfileRow): CashReferralManagerProfileV1 {
    return {
        driverId: String(row.id),
        fullName: row.fullName === null ? '' : String(row.fullName),
        phone: row.phone === null ? null : String(row.phone),
        licenseNumber: row.licenseNumber === null ? null : String(row.licenseNumber),
        externalParkId: row.externalParkId === null ? null : String(row.externalParkId),
        // Named by the service from the park metadata: no connection row is read here.
        parkName: null,
        employmentType: row.employmentType === null ? null : String(row.employmentType),
        isSelfEmployed: row.isSelfEmployed === null ? null : row.isSelfEmployed === true,
        dismissed: row.dismissedAt !== null,
        contactId: row.contactId === null ? null : String(row.contactId),
    }
}

export const legacyPrismaCashReferralManagerReadsV1 = {
    /**
     * Who a name or a phone belongs to, as Contacts answers it for every
     * module: live canonical Contacts only, in ContactLookup.v1's own order.
     */
    async lookupContacts(query: string, limit: number): Promise<{ contacts: { contactId: string; displayTitle: string; fullMatch: boolean }[]; truncated: boolean }> {
        const result = await searchContactsV1({ query, limit })
        return {
            contacts: result.items.map((item) => ({ contactId: item.contactId, displayTitle: item.displayTitle, fullMatch: cashReferralLookupFullMatchV1(item.match) })),
            truncated: result.truncated,
        }
    },

    /** Profiles whose licence, as letters and digits only, is the typed one. */
    async searchProfilesByLicence(licence: string, limit: number): Promise<CashReferralManagerProfileV1[]> {
        const rows = await prisma.$queryRawUnsafe<ProfileRow[]>(
            `SELECT d."id", d."fullName", d."phone", d."licenseNumber", d."externalParkId", d."contactId",
                    d."dismissedAt", d."isSelfEmployed", d."employmentType"
             FROM "Driver" d
             WHERE upper(regexp_replace(coalesce(d."licenseNumber", ''), '[^0-9A-Za-zА-Яа-яЁё]', '', 'g')) = $1::text
             ORDER BY d."fullName" ASC, d."id" ASC
             LIMIT $2`,
            licence,
            limit,
        )
        return rows.map(toProfileV1)
    },

    /** Every profile Fleet projects to one of these contacts. */
    async profilesOfContacts(contactIds: readonly string[]): Promise<CashReferralManagerProfileV1[]> {
        if (contactIds.length === 0) return []
        const rows = await prisma.$queryRawUnsafe<ProfileRow[]>(
            `SELECT d."id", d."fullName", d."phone", d."licenseNumber", d."externalParkId", d."contactId",
                    d."dismissedAt", d."isSelfEmployed", d."employmentType"
             FROM "Driver" d
             WHERE d."contactId" = ANY($1::text[])
             ORDER BY d."fullName" ASC, d."id" ASC
             LIMIT 200`,
            [...contactIds],
        )
        return rows.map(toProfileV1)
    },

    /** Contacts' own answer to which person a contact is now. */
    async resolveLineage(contactId: string): Promise<CashReferralLineageReadV1> {
        try {
            const lineage = await resolveContactLineageV1(contactId)
            if (!lineage) return { status: 'missing' }
            return { status: 'resolved', canonicalContactId: lineage.canonicalContactId, contactIds: lineage.contactIds }
        } catch (error) {
            const message = error instanceof Error ? error.message : ''
            if (message.startsWith('CONTACT_MERGE_REDIRECT_')) return { status: 'unresolvable' }
            throw error
        }
    },

    /**
     * Whether Contacts confirms one of these profiles as this contact's main
     * driver: the profile a Telegram link proves the person through in Cash.
     */
    async confirmedMainDriver(contactId: string, driverIds: readonly string[]): Promise<{ status: 'confirmed'; driverId: string } | { status: 'not_confirmed' | 'busy' }> {
        try {
            for (const driverId of driverIds) {
                if (await isContactConfirmedMainDriverV1(contactId, driverId)) return { status: 'confirmed', driverId }
            }
            return { status: 'not_confirmed' }
        } catch (error) {
            if (contactOwnershipBusyResultV1(error)) return { status: 'busy' }
            throw error
        }
    },
}
