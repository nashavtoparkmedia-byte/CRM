import { prisma } from '@/lib/prisma'

/**
 * Read side of the Mobile Push v1 logout barrier, used to authorize requests (BR-4).
 *
 * Logout (`clearMobileSessionV1`) records the session's barrier entry against
 * its device: on the device's registration row, or on a tombstone row when the
 * device never registered. The same entry therefore answers a second question
 * besides "may this session register for push": was this exact session logged
 * out? A token that a restored cookie jar or an in-flight request still
 * carries after logout verifies cryptographically, and only this read refuses
 * it. Nothing here writes; the barrier keeps a single writer.
 */
export const prismaMobileSessionBarrierV1 = {
    /** Whether `barrierEntry` is recorded against `deviceId`, i.e. that session was logged out. */
    async isBarred(deviceId: string, barrierEntry: string): Promise<boolean> {
        const barred = await prisma.mobileDeviceRegistration.count({
            where: { deviceId, revokedSessionBindings: { has: barrierEntry } },
        })
        return barred > 0
    },
}
