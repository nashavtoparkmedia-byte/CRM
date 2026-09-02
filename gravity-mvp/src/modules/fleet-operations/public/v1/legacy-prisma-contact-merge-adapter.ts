import type { Prisma } from '@prisma/client'
import type { AutomatedMergeRecoveryOwnerRepositoryV1 } from '@/modules/contacts/public/v1/automated-contact-merge-recovery'

/** Owner-scoped Driver/profile operations used by the shared Contact merge transaction. */
export function makeFleetContactMergeRepositories(transaction: Prisma.TransactionClient) {
  return {
    recovery: makeFleetAutomatedMergeRecoveryRepositoryV1(transaction),
    async findDriverById(driverId: string) {
      return transaction.driver.findUnique({
        where: { id: driverId },
        select: { id: true, yandexDriverId: true, fullName: true },
      })
    },
    async findDriverIdByYandexDriverId(yandexDriverId: string) {
      const driver = await transaction.driver.findUnique({
        where: { yandexDriverId },
        select: { id: true },
      })
      return driver?.id ?? null
    },
    async moveDriverProfilesToContact(sourceContactId: string, targetContactId: string) {
      await transaction.driver.updateMany({
        where: { contactId: sourceContactId },
        data: { contactId: targetContactId },
      })
    },
  }
}

export function makeFleetAutomatedMergeRecoveryRepositoryV1(
  transaction: Prisma.TransactionClient,
): AutomatedMergeRecoveryOwnerRepositoryV1 {
  return {
    async canRestore(plan) {
      if (plan.driverProfileIds.length === 0) return true
      return transaction.driver.count({
        where: { id: { in: plan.driverProfileIds }, contactId: plan.survivorId },
      }).then(count => count === plan.driverProfileIds.length)
    },
    async restore(plan) {
      if (plan.driverProfileIds.length === 0) return
      const result = await transaction.driver.updateMany({
        where: { id: { in: plan.driverProfileIds }, contactId: plan.survivorId },
        data: { contactId: plan.mergedId },
      })
      if (result.count !== plan.driverProfileIds.length) throw new Error('FLEET_RECOVERY_STATE_CHANGED')
    },
  }
}
