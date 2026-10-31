/**
 * Prisma implementation of the referral decision port. Fixed SQL only.
 *
 * Fleet reads its own Driver rows here and nothing of Telegram's: the invited
 * Driver is the one the bot route recorded on the attribution after proving
 * the Telegram account. Contacts is reached only through the pilot port's own
 * public reads (main-driver confirmation and lineage), and the provider only
 * through the bounded single-profile read, which the caller rations.
 *
 * Person keys and licence numbers are compared here and never returned past
 * the person key of the proven row, which the service turns into a digest.
 */

import { prisma } from '@/lib/prisma'

import type { YandexFleetDriverDismissalReadV1, YandexFleetDriverProfileTargetV1 } from '../legacy-prisma-yandex-fleet-reconciler-adapter'
import { legacyPrismaCompensationPilotPortV1 } from './legacy-prisma-compensation-pilot-adapter'
import { legacyPrismaCashReferralLedgerStoreV1 as store } from './legacy-prisma-cash-referral-ledger-adapter'
import type {
    CashReferralDecisionPortV1,
    CashReferralFleetProfileV1,
    CashReferralYandexReadV1,
} from './compensation-referral-service'

interface DriverFactsRow {
    id: string
    externalParkId: string | null
    externalDriverProfileId: string | null
    yandexHireDate: Date | null
    isSelfEmployed: boolean | null
    workStatus: string | null
    externalPersonKey: string | null
    personResolutionStatus: string | null
}

function profileOf(row: DriverFactsRow): CashReferralFleetProfileV1 | null {
    if (row.externalParkId === null || row.externalDriverProfileId === null) return null
    return {
        profileRef: `${row.externalParkId}:${row.externalDriverProfileId}`,
        externalParkId: String(row.externalParkId),
        externalDriverProfileId: String(row.externalDriverProfileId),
        registeredAt: row.yandexHireDate === null ? null : new Date(row.yandexHireDate),
    }
}

/**
 * Rations provider reads within one pass: a cap per pass, and a park that
 * answered 429 is not asked again until its cooldown has passed.
 */
export class CashReferralYandexReadRationV1 {
    private reads = 0
    private readonly cooldownUntil = new Map<string, number>()

    constructor(
        private readonly read: (target: YandexFleetDriverProfileTargetV1) => Promise<YandexFleetDriverDismissalReadV1>,
        private readonly limits: { perPass: number; cooldownMs: number; nowMs: () => number },
    ) {}

    startPass(): void {
        this.reads = 0
    }

    async readProfile(profile: CashReferralFleetProfileV1, at: Date): Promise<CashReferralYandexReadV1 | null> {
        const now = this.limits.nowMs()
        if (this.reads >= this.limits.perPass) return null
        if ((this.cooldownUntil.get(profile.externalParkId) ?? 0) > now) return null
        this.reads += 1
        const result = await this.read({ externalParkId: profile.externalParkId, externalDriverProfileId: profile.externalDriverProfileId })
        if (result.status === 'rate_limited') {
            this.cooldownUntil.set(profile.externalParkId, now + Math.max(result.retryAfterMs ?? 0, this.limits.cooldownMs))
            return null
        }
        if (result.status !== 'read') return null
        // The pass's database clock, taken before the read: never later than the read itself.
        return { workStatus: result.workStatus, fireDate: result.fireDate, readAt: at }
    }
}

export function legacyPrismaCashReferralDecisionPortV1(ration: CashReferralYandexReadRationV1): CashReferralDecisionPortV1 {
    let passClock: Date | null = null
    return {
        async findUndecided(limit) {
            ration.startPass()
            passClock = null
            return (await store.findUndecided(limit)).map((row) => ({
                id: row.id,
                inviterContactId: row.inviterContactId,
                inviterLineageDigest: row.inviterLineageDigest,
                inviteeTelegramUserId: row.inviteeTelegramUserId,
                inviteeDriverId: row.inviteeDriverId,
                state: row.state,
                reason: row.reason,
                capturedAt: row.capturedAt,
                version: row.version,
            }))
        },
        readChain: (contactId) => store.readChain(contactId),
        readAttributionEvents: (attributionId) => store.readAttributionEvents(attributionId),
        personAlreadyQualified: (digest, except) => store.personAlreadyQualified(digest, except),
        writeDecision: (write) => store.writeDecision(write),
        resolveContactLineage: (contactId) => legacyPrismaCompensationPilotPortV1.resolveContactLineage(contactId),
        async confirmMainDriver(contactId, driverId) {
            const confirmation = await legacyPrismaCompensationPilotPortV1.confirmMainDriver(contactId, driverId)
            return confirmation === 'confirmed' ? 'confirmed' : confirmation === 'busy' ? 'busy' : 'not_confirmed'
        },

        async findDriverContact(driverId) {
            const rows = await prisma.$queryRawUnsafe<Array<{ contactId: string | null }>>(
                `SELECT "contactId" FROM "Driver" WHERE "id" = $1`,
                driverId,
            )
            return rows.length === 0 ? null : { contactId: rows[0].contactId === null ? null : String(rows[0].contactId) }
        },

        async readInviteeFleetFacts(driverId) {
            const proven = await prisma.$queryRawUnsafe<DriverFactsRow[]>(
                `SELECT "id","externalParkId","externalDriverProfileId","yandexHireDate","isSelfEmployed",
                        "customFields"->'fleetSource'->>'workStatus' AS "workStatus","externalPersonKey","personResolutionStatus"
                 FROM "Driver"
                 WHERE "id" = $1`,
                driverId,
            )
            const row = proven[0]
            const provenProfile = row === undefined ? null : profileOf(row)
            if (row === undefined || provenProfile === null) return null
            let earlierProfiles: CashReferralFleetProfileV1[] | null = null
            if (row.externalPersonKey !== null && row.personResolutionStatus !== 'conflict') {
                const rows = await prisma.$queryRawUnsafe<DriverFactsRow[]>(
                    `SELECT "id","externalParkId","externalDriverProfileId","yandexHireDate","isSelfEmployed",
                            "customFields"->'fleetSource'->>'workStatus' AS "workStatus","externalPersonKey","personResolutionStatus"
                     FROM "Driver"
                     WHERE "externalParkId" = $1 AND "externalPersonKey" = $2 AND "id" <> $3`,
                    provenProfile.externalParkId,
                    row.externalPersonKey,
                    row.id,
                )
                // A row in conflict leaves the history unknown: the invitation waits.
                earlierProfiles = rows.some((other) => other.personResolutionStatus === 'conflict')
                    ? null
                    : rows.map(profileOf).filter((profile): profile is CashReferralFleetProfileV1 => profile !== null)
            }
            return {
                proven: provenProfile,
                isSelfEmployed: row.isSelfEmployed === null ? null : Boolean(row.isSelfEmployed),
                workStatus: row.workStatus === null ? null : String(row.workStatus),
                externalPersonKey: row.externalPersonKey === null ? null : String(row.externalPersonKey),
                earlierProfiles,
            }
        },

        async personKeysOfContact(contactId) {
            const rows = await prisma.$queryRawUnsafe<Array<{ externalPersonKey: string }>>(
                `SELECT DISTINCT "externalPersonKey" FROM "Driver"
                 WHERE "contactId" = $1 AND "externalPersonKey" IS NOT NULL`,
                contactId,
            )
            return rows.map((row) => String(row.externalPersonKey))
        },

        async contactsSharePhone(left, right) {
            const rows = await prisma.$queryRawUnsafe<Array<{ shared: number }>>(
                `SELECT 1 AS "shared"
                 FROM "Driver" AS "a" JOIN "Driver" AS "b" ON "a"."phone" = "b"."phone"
                 WHERE "a"."contactId" = $1 AND "b"."contactId" = $2 AND "a"."phone" IS NOT NULL AND "a"."phone" <> ''
                 LIMIT 1`,
                left,
                right,
            )
            return rows.length > 0
        },

        async readYandexProfile(profile) {
            const at = passClock ?? await this.now()
            return ration.readProfile(profile, at)
        },

        async now() {
            const rows = await prisma.$queryRawUnsafe<Array<{ now: Date }>>(`SELECT date_trunc('milliseconds', now()) AS "now"`)
            passClock = new Date(rows[0].now)
            return passClock
        },
    }
}
