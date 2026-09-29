/**
 * Prisma implementation of the readiness population read.
 *
 * One query, one table, seven columns: the identifiers readiness correlates on
 * and the three facts the Yandex fleet sync writes. No name, phone, licence or
 * unrelated Driver field is selected, so nothing the report must not print can
 * reach the report at all.
 *
 * The scope is the configured pilot parks. An empty scope reads nothing rather
 * than enumerating every driver in the database.
 */

import { prisma } from '@/lib/prisma'

import type { CompensationPilotReadinessPopulationPortV1 } from './compensation-pilot-readiness-service'

export const legacyPrismaCompensationPilotReadinessPortV1: CompensationPilotReadinessPopulationPortV1 = {
    async listPilotCandidateDrivers({ externalParkIds, limit }) {
        if (externalParkIds.length === 0) return []
        const rows = await prisma.driver.findMany({
            where: { externalParkId: { in: [...externalParkIds] } },
            select: {
                id: true,
                contactId: true,
                externalParkId: true,
                externalDriverProfileId: true,
                isSelfEmployed: true,
                employmentType: true,
                yandexHireDate: true,
            },
            // Stable order, so a truncated population is the same set twice.
            orderBy: { id: 'asc' },
            take: limit,
        })
        return rows.map((row) => ({
            driverId: row.id,
            contactId: row.contactId,
            externalParkId: row.externalParkId,
            externalDriverProfileId: row.externalDriverProfileId,
            facts: {
                isSelfEmployed: row.isSelfEmployed,
                employmentType: row.employmentType,
                parkHireDate: row.yandexHireDate,
            },
        }))
    },
}
