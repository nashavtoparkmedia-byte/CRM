import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { mobileSessionBarrierEntryExpiryV1 } from './mobile-session-credentials'
import type {
    MobilePushBindOutcomeV1,
    MobilePushLogoutBarrierV1,
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

/**
 * The barrier entries worth keeping: this logout's entry, plus every entry
 * whose session has not expired yet. An expired entry bars a session that can
 * no longer be presented at all, so dropping it changes nothing and keeps the
 * stored barrier bounded by the logins of one session lifetime.
 */
function keptBarrierEntries(existing: string[], entry: string, now: Date): string[] {
    const nowSeconds = Math.floor(now.getTime() / 1000)
    const kept = existing.filter((candidate) => {
        if (candidate === entry) return false
        const expiry = mobileSessionBarrierEntryExpiryV1(candidate)
        return expiry !== null && expiry > nowSeconds
    })
    kept.push(entry)
    return kept
}

/**
 * Refusal raised inside the reclaim transaction. Returning a refusal would
 * COMMIT the release of the holder's token that the transaction already did;
 * throwing rolls it back, so a registration that is refused changes nothing.
 */
class MobilePushReclaimRefusal extends Error {
    constructor(readonly outcome: 'session_revoked' | 'holder_not_reclaimable') {
        super(`MOBILE_PUSH_RECLAIM_REFUSED:${outcome}`)
        this.name = 'MobilePushReclaimRefusal'
    }
}

export const prismaMobileDeviceRegistrationPortV1: MobilePushRegistrationPortV1 = {
    async bind(write): Promise<MobilePushBindOutcomeV1> {
        for (let attempt = 0; attempt < MAX_INSERT_RACE_ROUNDS; attempt += 1) {
            const activated = await prisma.mobileDeviceRegistration.updateMany({
                where: { deviceId: write.deviceId, NOT: { revokedSessionBindings: { has: write.barrierEntry } } },
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
                if (existing.revokedSessionBindings.includes(write.barrierEntry)) return { outcome: 'session_revoked' }
                continue
            }

            try {
                // First registration for this device, written field by field.
                const created = await prisma.mobileDeviceRegistration.create({
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
                return { outcome: 'bound', registrationId: created.id }
            } catch (error) {
                if (isUniqueViolationOn(error, 'fcmToken')) return { outcome: 'token_conflict' }
                // Another request inserted this device first: re-run the
                // conditional bind against the row it committed.
                if (!isUniqueViolationOn(error, 'deviceId')) throw error
            }
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
                    where: { deviceId: write.deviceId, NOT: { revokedSessionBindings: { has: write.barrierEntry } } },
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
                // Thrown, not returned: the release above must roll back with
                // the refusal, so a registration that is refused leaves the
                // holder exactly as it found it.
                if (existing) {
                    throw new MobilePushReclaimRefusal(
                        existing.revokedSessionBindings.includes(write.barrierEntry) ? 'session_revoked' : 'holder_not_reclaimable',
                    )
                }
                const created = await transaction.mobileDeviceRegistration.create({
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
                return { outcome: 'bound' as const, registrationId: created.id }
            })
        } catch (error) {
            // Every exit below rolled the transaction back, release included.
            if (error instanceof MobilePushReclaimRefusal) return { outcome: error.outcome }
            // Another device bound the token between the release and our bind.
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

    async revokeDevice(deviceId, barrier, session, reason, now) {
        for (let attempt = 0; attempt < MAX_INSERT_RACE_ROUNDS; attempt += 1) {
            const outcome = await prisma.$transaction(async (transaction) => {
                const revoked = await transaction.mobileDeviceRegistration.updateMany({
                    where: { deviceId },
                    data: { revokedAt: now, revokedReason: reason, fcmToken: null },
                })
                if (revoked.count > 0) {
                    if (barrier) {
                        // The row is locked by the update above, so this
                        // read-prune-write cannot lose a concurrent logout's entry.
                        const row = await transaction.mobileDeviceRegistration.findUnique({
                            where: { deviceId },
                            select: { revokedSessionBindings: true },
                        })
                        await transaction.mobileDeviceRegistration.updateMany({
                            where: { deviceId },
                            // A plain list, not { set: … }: the operator form
                            // reads as a nested relation write the analyzer
                            // cannot resolve, and this writes the same value.
                            data: { revokedSessionBindings: keptBarrierEntries(row?.revokedSessionBindings ?? [], barrier.entry, now) },
                        })
                    }
                    return revoked.count
                }
                if (!barrier) return 0
                // The device never registered. A tombstone carries the barrier,
                // so a registration still in flight from this session cannot
                // create one afterwards.
                await transaction.mobileDeviceRegistration.create({
                    data: {
                        deviceId,
                        fcmToken: null,
                        credentialSubject: session.credentialSubject,
                        runtimeOperatorId: session.runtimeOperatorId,
                        sessionBindingId: barrier.sessionBindingId,
                        sessionIssuedAt: session.sessionIssuedAt,
                        sessionExpiresAt: session.sessionExpiresAt,
                        sessionRevocationEpoch: session.sessionRevocationEpoch,
                        lastSeenAt: now,
                        revokedAt: now,
                        revokedReason: reason,
                        revokedSessionBindings: [barrier.entry],
                    },
                    select: { id: true },
                })
                return 0
            }).catch((error: unknown) => {
                // A registration for this device committed first: re-run and
                // revoke it instead.
                if (isUniqueViolationOn(error, 'deviceId')) return null
                throw error
            })
            if (outcome !== null) return outcome
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
