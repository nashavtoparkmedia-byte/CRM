import { prisma } from '@/lib/prisma'

/**
 * Narrow provider capability for Yandex Fleet requests. Callers receive only
 * the three values required to construct a provider request; no Prisma row or
 * credential-bearing relation can cross the fleet boundary.
 */
export type YandexConnectionCredentialsV1 = {
    connectionId: string
    localParkId: string | null
    clid: string
    apiKey: string
    parkId: string
    name?: string | null
}

/**
 * The legacy ApiConnection fallback predates ParkConnection and can contain
 * the same provider credentials under multiple display names.  Repeating an
 * identical provider request only consumes Fleet quota; credentials that
 * differ are deliberately retained for explicit reconciliation/diagnostics.
 */
export function dedupeYandexConnectionCredentialsV1(
    connections: readonly YandexConnectionCredentialsV1[],
): YandexConnectionCredentialsV1[] {
    const seen = new Set<string>()
    return connections.filter((connection) => {
        const identity = `${connection.parkId}\0${connection.clid}\0${connection.apiKey}`
        if (seen.has(identity)) return false
        seen.add(identity)
        return true
    })
}

const yandexCredentialsSelect = {
    id: true,
    clid: true,
    apiKey: true,
    parkId: true,
    name: true,
} as const

export async function getYandexConnectionCredentialsV1(
    connectionId?: string,
    parkId?: string,
): Promise<YandexConnectionCredentialsV1 | null> {
    const connection = await prisma.apiConnection.findFirst({
        ...((connectionId || parkId) ? { where: { ...(connectionId ? { id: connectionId } : {}), ...(parkId ? { parkId } : {}) } } : {}),
        orderBy: { createdAt: 'desc' },
        select: yandexCredentialsSelect,
    })
    if (!connection) return null
    const parkConnection = await prisma.parkConnection.findFirst({
        where: { apiConnectionId: connection.id, enabled: true, archivedAt: null },
        select: { parkId: true },
    })
    return { ...connection, connectionId: connection.id, localParkId: parkConnection?.parkId ?? null }
}

export async function listYandexConnectionCredentialsV1(): Promise<YandexConnectionCredentialsV1[]> {
    const configured = await prisma.parkConnection.findMany({
        where: { enabled: true, archivedAt: null, park: { active: true } },
        orderBy: [{ park: { parkCode: 'asc' } }, { apiConnection: { createdAt: 'asc' } }],
        select: {
            parkId: true,
            externalParkId: true,
            apiConnection: { select: yandexCredentialsSelect },
        },
    })
    if (configured.length > 0) {
        return dedupeYandexConnectionCredentialsV1(configured.map(row => ({
            ...row.apiConnection,
            connectionId: row.apiConnection.id,
            localParkId: row.parkId,
            parkId: row.externalParkId,
        })))
    }
    const legacy = await prisma.apiConnection.findMany({
        orderBy: { createdAt: 'asc' },
        select: yandexCredentialsSelect,
    })
    return dedupeYandexConnectionCredentialsV1(legacy.map(connection => ({
        ...connection,
        connectionId: connection.id,
        localParkId: null,
    })))
}

export async function listYandexConnectionMetadataV1(): Promise<Array<{ parkId: string; name: string | null }>> {
    return prisma.apiConnection.findMany({
        select: { parkId: true, name: true },
        orderBy: { createdAt: 'asc' },
    })
}
