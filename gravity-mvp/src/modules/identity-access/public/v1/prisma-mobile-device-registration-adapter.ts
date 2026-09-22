import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type {
    MobilePushBindOutcomeV1,
    MobilePushEligibilityFactsV1,
    MobilePushRegistrationPortV1,
    MobilePushRegistrationWriteV1,
} from './mobile-push-registration-handler'

/**
 * PostgreSQL storage for Mobile Push v1 device registrations.
 *
 * Two uniqueness invariants carry the concurrency guarantees: UNIQUE(deviceId)
 * makes a device's concurrent registrations converge on one row (the upsert is
 * a native INSERT … ON CONFLICT), and UNIQUE(fcmToken) makes a live token
 * belong to at most one device. Nothing here logs or returns a token except
 * `currentToken`, which exists for the send-time resolution only.
 */

const ELIGIBILITY_LIMIT = 1000

function isUniqueViolationOn(error: unknown, field: 'fcmToken' | 'deviceId'): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false
    const target = (error.meta as { target?: unknown } | undefined)?.target
    const names = Array.isArray(target) ? target.map(String) : [String(target ?? '')]
    return names.some((name) => name === field || name.includes(`_${field}_`))
}

function registrationData(write: MobilePushRegistrationWriteV1) {
    return {
        fcmToken: write.fcmToken,
        credentialSubject: write.credentialSubject,
        runtimeOperatorId: write.runtimeOperatorId,
        sessionBindingId: write.sessionBindingId,
        sessionIssuedAt: write.sessionIssuedAt,
        sessionExpiresAt: write.sessionExpiresAt,
        sessionRevocationEpoch: write.sessionRevocationEpoch,
        credentialKeyId: write.credentialKeyId,
        lastSeenAt: write.now,
    }
}

/** Server facts under which a holder can no longer receive push. */
function ineligibleWhere(facts: MobilePushEligibilityFactsV1): Prisma.MobileDeviceRegistrationWhereInput[] {
    return [
        { revokedAt: { not: null } },
        { sessionExpiresAt: { lte: facts.now } },
        { sessionRevocationEpoch: { not: facts.revocationEpoch } },
        { credentialKeyId: { not: facts.credentialKeyId } },
        { credentialSubject: { not: facts.credentialSubject } },
    ]
}

async function upsertByDevice(
    client: Prisma.TransactionClient,
    write: MobilePushRegistrationWriteV1,
): Promise<string> {
    const row = await client.mobileDeviceRegistration.upsert({
        where: { deviceId: write.deviceId },
        create: { deviceId: write.deviceId, ...registrationData(write) },
        update: { ...registrationData(write), revokedAt: null, revokedReason: null },
        select: { id: true },
    })
    return row.id
}

export const prismaMobileDeviceRegistrationPortV1: MobilePushRegistrationPortV1 = {
    async bind(write): Promise<MobilePushBindOutcomeV1> {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                return { outcome: 'bound', registrationId: await upsertByDevice(prisma, write) }
            } catch (error) {
                if (isUniqueViolationOn(error, 'fcmToken')) return { outcome: 'token_conflict' }
                // A first registration racing another for the same device: the
                // loser re-runs and lands on the winner's row.
                if (attempt === 0 && isUniqueViolationOn(error, 'deviceId')) continue
                throw error
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
                return { outcome: 'bound' as const, registrationId: await upsertByDevice(transaction, write) }
            })
        } catch (error) {
            // Another device bound the token between the release and our bind:
            // the whole transaction, release included, rolled back.
            if (isUniqueViolationOn(error, 'fcmToken')) return { outcome: 'token_conflict' as const }
            throw error
        }
    },

    async tokenIsBound(token) {
        return (await prisma.mobileDeviceRegistration.count({ where: { fcmToken: token } })) > 0
    },

    async revokeDevice(deviceId, reason, now) {
        const revoked = await prisma.mobileDeviceRegistration.updateMany({
            where: { deviceId, revokedAt: null },
            data: { revokedAt: now, revokedReason: reason, fcmToken: null },
        })
        return revoked.count
    },

    async listEligible(facts) {
        const rows = await prisma.mobileDeviceRegistration.findMany({
            where: {
                revokedAt: null,
                fcmToken: { not: null },
                sessionExpiresAt: { gt: facts.now },
                sessionRevocationEpoch: facts.revocationEpoch,
                credentialKeyId: facts.credentialKeyId,
                credentialSubject: facts.credentialSubject,
            },
            select: { id: true, sessionBindingId: true },
            orderBy: { id: 'asc' },
            take: ELIGIBILITY_LIMIT,
        })
        return rows.map((row) => ({ registrationId: row.id, sessionBindingId: row.sessionBindingId }))
    },

    async view(registrationId) {
        const row = await prisma.mobileDeviceRegistration.findUnique({
            where: { id: registrationId },
            select: {
                id: true,
                fcmToken: true,
                sessionBindingId: true,
                sessionExpiresAt: true,
                sessionRevocationEpoch: true,
                credentialSubject: true,
                credentialKeyId: true,
                revokedAt: true,
            },
        })
        if (!row) return null
        return {
            id: row.id,
            hasToken: row.fcmToken !== null,
            sessionBindingId: row.sessionBindingId,
            sessionExpiresAt: row.sessionExpiresAt,
            sessionRevocationEpoch: row.sessionRevocationEpoch,
            credentialSubject: row.credentialSubject,
            credentialKeyId: row.credentialKeyId,
            revoked: row.revokedAt !== null,
        }
    },

    async currentToken(registrationId) {
        const row = await prisma.mobileDeviceRegistration.findUnique({
            where: { id: registrationId },
            select: { fcmToken: true },
        })
        return row?.fcmToken ?? null
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
