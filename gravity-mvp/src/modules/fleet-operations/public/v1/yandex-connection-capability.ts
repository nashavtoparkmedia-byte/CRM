import { prisma } from '@/lib/prisma'

/**
 * Narrow provider capability for Yandex Fleet requests. Callers receive only
 * the three values required to construct a provider request; no Prisma row or
 * credential-bearing relation can cross the fleet boundary.
 */
export type YandexConnectionCredentialsV1 = {
    clid: string
    apiKey: string
    parkId: string
    name?: string | null
}

const yandexCredentialsSelect = {
    clid: true,
    apiKey: true,
    parkId: true,
    name: true,
} as const

export async function getYandexConnectionCredentialsV1(
    connectionId?: string,
    parkId?: string,
): Promise<YandexConnectionCredentialsV1 | null> {
    return prisma.apiConnection.findFirst({
        ...((connectionId || parkId) ? { where: { ...(connectionId ? { id: connectionId } : {}), ...(parkId ? { parkId } : {}) } } : {}),
        orderBy: { createdAt: 'desc' },
        select: yandexCredentialsSelect,
    })
}

export async function listYandexConnectionCredentialsV1(): Promise<YandexConnectionCredentialsV1[]> {
    return prisma.apiConnection.findMany({
        orderBy: { createdAt: 'asc' },
        select: yandexCredentialsSelect,
    })
}

export async function listYandexConnectionMetadataV1(): Promise<Array<{ parkId: string; name: string | null }>> {
    return prisma.apiConnection.findMany({
        select: { parkId: true, name: true },
        orderBy: { createdAt: 'asc' },
    })
}
