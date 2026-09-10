import { Prisma } from '@prisma/client'
import type { AutomatedMergeRecoveryOwnerRepositoryV1 } from '@/modules/contacts/public/v1/automated-contact-merge-recovery'

const FLEET_RECONCILIATION_ADVISORY_CLASS_ID = 0x594f4b4f
const FLEET_RECONCILIATION_ADVISORY_OBJECT_ID = 0x464c5431 // "FLT1"

/**
 * Fleet-owned transaction fence shared by reconciliation mutations and the
 * automatic Contact-merge evidence read. Callers that also need CNT1 must
 * acquire this fence first, matching Fleet's established FLT1 -> CNT1 order.
 */
export async function admitFleetReconciliationTransactionV1(
  transaction: Prisma.TransactionClient,
): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    WITH "fleet_reconciliation_lock_policy" AS MATERIALIZED (
      SELECT set_config('lock_timeout', '10000ms', true) AS configured
    )
    SELECT (
      pg_advisory_xact_lock(
        CAST(${FLEET_RECONCILIATION_ADVISORY_CLASS_ID} AS integer)
          + octet_length(configured) * 0,
        CAST(${FLEET_RECONCILIATION_ADVISORY_OBJECT_ID} AS integer)
      ) IS NULL
    ) AS admitted
    FROM "fleet_reconciliation_lock_policy"
  `)
}

/** Owner-scoped Driver/profile operations used by the shared Contact merge transaction. */
export function makeFleetContactMergeRepositories(transaction: Prisma.TransactionClient) {
  return {
    recovery: makeFleetAutomatedMergeRecoveryRepositoryV1(transaction),
    async admitAutomaticMergeEvidenceRead() {
      await admitFleetReconciliationTransactionV1(transaction)
    },
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
      const archivedContactDriverCount = await transaction.driver.count({
        where: { contactId: plan.mergedId },
      })
      if (archivedContactDriverCount !== 0) return false
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
