import { prisma } from '@/lib/prisma'
import type { ReconcileDriverProfilePersistencePortV1 } from './reconcile-driver-profile-handler'

export const legacyPrismaReconcileDriverProfilePortV1: ReconcileDriverProfilePersistencePortV1 = {
  async reconcile(input) {
    await prisma.driver.upsert({
      where: { yandexDriverId: input.yandexDriverId },
      create: { yandexDriverId: input.yandexDriverId, fullName: input.fullName, lastOrderAt: input.lastOrderAt, segment: 'unknown' },
      update: { fullName: input.fullName, lastOrderAt: input.lastOrderAt },
    })
  },
}
