import { prisma } from '@/lib/prisma'
import type { CrmUserQueryPortV1 } from './crm-user-query-handler'

/** Exact compatibility read for the legacy database-backed CRM assignee directory. */
export const legacyPrismaCrmUserQueryPortV1: CrmUserQueryPortV1 = {
    async findById(userId) {
        return prisma.crmUser.findUnique({
            where: { id: userId },
            select: { id: true, name: true },
        })
    },
}
