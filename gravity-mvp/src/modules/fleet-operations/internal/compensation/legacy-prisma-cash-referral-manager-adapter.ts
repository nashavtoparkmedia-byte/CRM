/**
 * Prisma reads for the Cash referral manager screens. Read-only.
 *
 * Profiles are Fleet's own Driver rows; park names come to the service from
 * the park metadata capability, never from a connection row read here. Who a
 * profile's person is comes from Contacts through its public lineage and
 * confirmation reads only; Contacts tables are never read here.
 *
 * Each statement below is written out in full, so the analyzer reads it end
 * to end as a read of one named table.
 */

import { prisma } from '@/lib/prisma'
import {
    contactOwnershipBusyResultV1,
    isContactConfirmedMainDriverV1,
    resolveContactLineageV1,
} from '@/modules/contacts/public/v1'

import {
    cashReferralLicenceKeyV1,
    type CashReferralLineageReadV1,
    type CashReferralManagerHitV1,
    type CashReferralManagerProfileV1,
    type CashReferralManagerQueryV1,
    type CashReferralMatchV1,
} from './cash-referral-manager'

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

/** Names compare without case and with ё as е, the way managers type them. */
function nameKeyV1(text: string): string {
    return text.toLowerCase().replace(/ё/gu, 'е')
}

function matchesOfV1(profile: CashReferralManagerProfileV1, query: CashReferralManagerQueryV1): CashReferralMatchV1[] {
    const matched: CashReferralMatchV1[] = []
    const name = nameKeyV1(profile.fullName)
    if (query.nameTokens.length > 0 && query.nameTokens.every((token) => name.includes(nameKeyV1(token)))) matched.push('name')
    if (query.phoneDigits !== null && (profile.phone ?? '').replace(/\D/gu, '').endsWith(query.phoneDigits)) matched.push('phone')
    if (query.licence !== null && cashReferralLicenceKeyV1(profile.licenseNumber) === query.licence) matched.push('licence')
    return matched
}

export const legacyPrismaCashReferralManagerReadsV1 = {
    /**
     * Profiles whose name holds every typed word, whose phone ends in the
     * typed digits, or whose licence is the typed one. Each hit says which.
     */
    async searchProfiles(query: CashReferralManagerQueryV1, limit: number): Promise<CashReferralManagerHitV1[]> {
        // Name words hold letters and hyphens only, so they carry no LIKE wildcard of their own.
        const patterns = query.nameTokens.map((token) => `%${nameKeyV1(token)}%`)
        const rows = await prisma.$queryRawUnsafe<ProfileRow[]>(
            `SELECT d."id", d."fullName", d."phone", d."licenseNumber", d."externalParkId", d."contactId",
                    d."dismissedAt", d."isSelfEmployed", d."employmentType"
             FROM "Driver" d
             WHERE (cardinality($1::text[]) > 0 AND translate(lower(coalesce(d."fullName", '')), 'ё', 'е') LIKE ALL ($1::text[]))
                OR ($2::text IS NOT NULL AND right(regexp_replace(coalesce(d."phone", ''), '[^0-9]', '', 'g'), length($2::text)) = $2::text)
                OR ($3::text IS NOT NULL AND upper(regexp_replace(coalesce(d."licenseNumber", ''), '[^0-9A-Za-zА-Яа-яЁё]', '', 'g')) = $3::text)
             ORDER BY d."fullName" ASC, d."id" ASC
             LIMIT $4`,
            patterns,
            query.phoneDigits,
            query.licence,
            limit,
        )
        return rows.map(toProfileV1).map((profile) => ({ profile, matchedBy: matchesOfV1(profile, query) }))
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
