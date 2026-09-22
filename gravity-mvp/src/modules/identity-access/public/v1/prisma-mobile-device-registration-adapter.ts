import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type {
    MobilePushBindOutcomeV1,
    MobilePushEligibilityFactsV1,
    MobilePushRegistrationPortV1,
    MobilePushRegistrationWriteV1,
    MobilePushRevokedSessionFactsV1,
} from './mobile-push-registration-handler'

/**
 * PostgreSQL storage for Mobile Push v1 device registrations.
 *
 * Two uniqueness invariants carry the concurrency guarantees: UNIQUE(deviceId)
 * makes a device's concurrent registrations converge on one row, and
 * UNIQUE(fcmToken) makes a live token belong to at most one device. Nothing
 * here logs or returns a token except `sendableToken`, which exists for the
 * send-time resolution only.
 *
 * The logout barrier is enforced by the database, never by a read followed by
 * a write: every bind is a conditional UPDATE whose WHERE excludes this
 * device's revoked session bindings. PostgreSQL re-evaluates that condition
 * against the committed row after taking its lock, so a logout landing
 * mid-flight either wins the row first (the bind matches nothing and is
 * refused) or waits (and then revokes what the bind wrote). When no row
 * exists, UNIQUE(deviceId) forces the same ordering: the loser of the insert
 * race re-runs and meets the winner's committed state.
 */

const ELIGIBILITY_LIMIT = 1000
const MAX_INSERT_RACE_ROUNDS = 3

/** Client of either the pool or an open transaction; both write the same row shape. */
type RegistrationWriter = Pick<typeof prisma, 'mobileDeviceRegistration'>

/**
 * First registration for a device. Returns null on a token conflict and
 * undefined when another transaction inserted this device first, which the
 * caller resolves by re-running the conditional bind against that row.
 */
async function insertRegistration(
    writer: RegistrationWriter,
    write: MobilePushRegistrationWriteV1,
): Promise<{ id: string } | null | undefined> {
    try {
        return await writer.mobileDeviceRegistration.create({
            data: {
                deviceId: write.deviceId,
                fcmToken: write.fcmToken,
                credentialSubject: write.credentialSubject,
                runtimeOperatorId: write.runtimeOperatorId,
                sessionBindingId: write.sessionBindingId,
                sessionIssuedAt: write.sessionIssuedAt,
                sessionExpiresAt: write.sessionExpiresAt,
                sessionRevocationEpoch: write.sessionRevocationEpoch,
                lastSeenAt: write.now,
            },
            select: { id: true },
        })
    } catch (error) {
        if (isUniqueViolationOn(error, 'fcmToken')) return null
        if (isUniqueViolationOn(error, 'deviceId')) return undefined
        throw error
    }
}

function isUniqueViolationOn(error: unknown, field: 'fcmToken' | 'deviceId'): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false
    const target = (error.meta as { target?: unknown } | undefined)?.target
    const names = Array.isArray(target) ? target.map(String) : [String(target ?? '')]
    return names.some((name) => name === field || name.includes(`_${field}_`))
}

/** Server facts under which a holder can no longer receive push. */
function ineligibleWhere(facts: MobilePushEligibilityFactsV1): Prisma.MobileDeviceRegistrationWhereInput[] {
    return [
        { revokedAt: { not: null } },
        { sessionExpiresAt: { lte: facts.now } },
        { sessionRevocationEpoch: { not: facts.revocationEpoch } },
        { credentialSubject: { not: facts.credentialSubject } },
    ]
}

export const prismaMobileDeviceRegistrationPortV1: MobilePushRegistrationPortV1 = {
    async bind(write): Promise<MobilePushBindOutcomeV1> {
        for (let attempt = 0; attempt < MAX_INSERT_RACE_ROUNDS; attempt += 1) {
            const activated = await prisma.mobileDeviceRegistration.updateMany({
                where: { deviceId: write.deviceId, NOT: { revokedSessionBindings: { has: write.sessionBindingId } } },
                // Written field by field on purpose: every stored fact is
                // explicit and comes from the verified session.
                data: {
                    fcmToken: write.fcmToken,
                    credentialSubject: write.credentialSubject,
                    runtimeOperatorId: write.runtimeOperatorId,
                    sessionBindingId: write.sessionBindingId,
                    sessionIssuedAt: write.sessionIssuedAt,
                    sessionExpiresAt: write.sessionExpiresAt,
                    sessionRevocationEpoch: write.sessionRevocationEpoch,
                    lastSeenAt: write.now,
                    revokedAt: null,
                    revokedReason: null,
                },
            }).catch((error: unknown) => {
                if (isUniqueViolationOn(error, 'fcmToken')) return null
                throw error
            })
            if (activated === null) return { outcome: 'token_conflict' }
            if (activated.count === 1) {
                const row = await prisma.mobileDeviceRegistration.findUnique({
                    where: { deviceId: write.deviceId },
                    select: { id: true },
                })
                if (row) return { outcome: 'bound', registrationId: row.id }
                continue
            }

            // Nothing was updated: this device has no row yet, its row carries
            // this session's logout in the barrier, or a concurrent request
            // created the row after the update ran. Only a committed barrier
            // refuses; anything else re-runs the conditional update, which is
            // what actually enforces it.
            const existing = await prisma.mobileDeviceRegistration.findUnique({
                where: { deviceId: write.deviceId },
                select: { revokedSessionBindings: true },
            })
            if (existing) {
                if (existing.revokedSessionBindings.includes(write.sessionBindingId)) return { outcome: 'session_revoked' }
                continue
            }

            const created = await insertRegistration(prisma, write)
            if (created) return { outcome: 'bound', registrationId: created.id }
            if (created === null) return { outcome: 'token_conflict' }
        }
        throw new Error('MOBILE_PUSH_REGISTRATION_BIND_UNRESOLVED')
    },

    async reclaimFromIneligibleHolderAndBind(write, facts) {
        try {
            return await prisma.$transaction(async (transaction) => {
                const released = await transaction.mobileDeviceRegistration.updateMany({
                    where: {
                        fcmToken: write.fcmToken,
                        deviceId: { not: write.deviceId },
                        OR: ineligibleWhere(facts),
                    },
                    data: { fcmToken: null, revokedAt: facts.now, revokedReason: 'token_rebound' },
                })
                if (released.count === 0) return { outcome: 'holder_not_reclaimable' as const }
                const activated = await transaction.mobileDeviceRegistration.updateMany({
                    where: { deviceId: write.deviceId, NOT: { revokedSessionBindings: { has: write.sessionBindingId } } },
                    data: {
                        fcmToken: write.fcmToken,
                        credentialSubject: write.credentialSubject,
                        runtimeOperatorId: write.runtimeOperatorId,
                        sessionBindingId: write.sessionBindingId,
                        sessionIssuedAt: write.sessionIssuedAt,
                        sessionExpiresAt: write.sessionExpiresAt,
                        sessionRevocationEpoch: write.sessionRevocationEpoch,
                        lastSeenAt: write.now,
                        revokedAt: null,
                        revokedReason: null,
                    },
                })
                if (activated.count === 1) {
                    const row = await transaction.mobileDeviceRegistration.findUnique({
                        where: { deviceId: write.deviceId },
                        select: { id: true },
                    })
                    if (row) return { outcome: 'bound' as const, registrationId: row.id }
                }
                const existing = await transaction.mobileDeviceRegistration.findUnique({
                    where: { deviceId: write.deviceId },
                    select: { revokedSessionBindings: true },
                })
                // The release and everything after it roll back together, so a
                // refused or retried bind never leaves the holder released.
                if (existing) {
                    return existing.revokedSessionBindings.includes(write.sessionBindingId)
                        ? { outcome: 'session_revoked' as const }
                        : { outcome: 'holder_not_reclaimable' as const }
                }
                const created = await insertRegistration(transaction, write)
                if (created) return { outcome: 'bound' as const, registrationId: created.id }
                return { outcome: 'token_conflict' as const }
            })
        } catch (error) {
            // Another device bound the token between the release and our bind:
            // the whole transaction, release included, rolled back.
            if (isUniqueViolationOn(error, 'fcmToken')) return { outcome: 'token_conflict' as const }
            if (isUniqueViolationOn(error, 'deviceId')) return { outcome: 'holder_not_reclaimable' as const }
            throw error
        }
    },

    async tokenIsBoundToOtherDevice(token, deviceId) {
        const holders = await prisma.mobileDeviceRegistration.count({
            where: { fcmToken: token, deviceId: { not: deviceId } },
        })
        return holders > 0
    },

    async revokeDevice(deviceId, sessionBindingId, session, reason, now) {
        for (let attempt = 0; attempt < MAX_INSERT_RACE_ROUNDS; attempt += 1) {
            const revoked = await prisma.mobileDeviceRegistration.updateMany({
                where: { deviceId },
                data: {
                    revokedAt: now,
                    revokedReason: reason,
                    fcmToken: null,
                    revokedSessionBindings: { push: sessionBindingId },
                },
            })
            if (revoked.count > 0) return revoked.count

            // The device never registered. A tombstone carries the barrier, so
            // a registration still in flight from this session cannot create
            // one afterwards.
            try {
                await prisma.mobileDeviceRegistration.create({
                    data: {
                        deviceId,
                        fcmToken: null,
                        credentialSubject: session.credentialSubject,
                        runtimeOperatorId: session.runtimeOperatorId,
                        sessionBindingId,
                        sessionIssuedAt: session.sessionIssuedAt,
                        sessionExpiresAt: session.sessionExpiresAt,
                        sessionRevocationEpoch: session.sessionRevocationEpoch,
                        lastSeenAt: now,
                        revokedAt: now,
                        revokedReason: reason,
                        revokedSessionBindings: [sessionBindingId],
                    },
                    select: { id: true },
                })
                return 0
            } catch (error) {
                // A registration for this device committed first: re-run and
                // revoke it instead.
                if (!isUniqueViolationOn(error, 'deviceId')) throw error
            }
        }
        throw new Error('MOBILE_PUSH_REGISTRATION_REVOKE_UNRESOLVED')
    },

    async listEligible(facts) {
        const rows = await prisma.mobileDeviceRegistration.findMany({
            where: {
                revokedAt: null,
                fcmToken: { not: null },
                sessionExpiresAt: { gt: facts.now },
                sessionRevocationEpoch: facts.revocationEpoch,
                credentialSubject: facts.credentialSubject,
            },
            select: { id: true, sessionBindingId: true },
            orderBy: { id: 'asc' },
            take: ELIGIBILITY_LIMIT,
        })
        return rows.map((row) => ({ registrationId: row.id, sessionBindingId: row.sessionBindingId }))
    },

    async status(registrationId) {
        const row = await prisma.mobileDeviceRegistration.findUnique({
            where: { id: registrationId },
            select: { id: true, sessionBindingId: true, revokedAt: true },
        })
        if (!row) return null
        return { id: row.id, sessionBindingId: row.sessionBindingId, revoked: row.revokedAt !== null }
    },

    async sendableToken(registrationId, sessionBindingId, facts) {
        const row = await prisma.mobileDeviceRegistration.findFirst({
            where: {
                id: registrationId,
                sessionBindingId,
                revokedAt: null,
                sessionExpiresAt: { gt: facts.now },
                sessionRevocationEpoch: facts.revocationEpoch,
                credentialSubject: facts.credentialSubject,
            },
            select: { fcmToken: true },
        })
        return row ? { sendable: true, token: row.fcmToken } : { sendable: false }
    },

    async clearTokenIfCurrent(registrationId, rejectedToken) {
        const cleared = await prisma.mobileDeviceRegistration.updateMany({
            where: { id: registrationId, fcmToken: rejectedToken },
            data: { fcmToken: null },
        })
        return cleared.count === 1
    },

    async revokeIfTokenCurrent(registrationId, rejectedToken, reason, now) {
        const revoked = await prisma.mobileDeviceRegistration.updateMany({
            where: { id: registrationId, fcmToken: rejectedToken },
            data: { fcmToken: null, revokedAt: now, revokedReason: reason },
        })
        return revoked.count === 1
    },
}
