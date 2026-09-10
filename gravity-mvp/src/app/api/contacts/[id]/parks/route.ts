import { NextRequest, NextResponse } from 'next/server'
import {
    getContactParkCheckContextV1,
    persistContactParkCheckResultV1,
    type ContactParkCheckSnapshotV1,
    type ContactParkCheckStatusV1,
} from '@/modules/contacts/public/v1'
import {
    getParkLinkedDriverPhoneV1,
    normalizeParkPhoneDigitsV1,
    searchYandexParksByPhonesV1,
    type ParkPhoneSearchResultV1,
} from '@/modules/fleet-operations/public/v1'
import { attemptAutomaticContactMergeFromPlatformV1 } from '@/modules/platform-shell/internal/contact-park-merge-orchestrator'
import {
    getIntegrationAdminPrincipal,
    isExactSameOriginMutationRequest,
} from '@/modules/identity-access/public/v1'

type DriverLinkResult = {
    status: 'not_found' | 'ambiguous' | 'review_required' | 'linked' | 'already_linked' | 'merged' | 'error'
    contactId: string | null
    driverId: string | null
    displayName: string | null
    message: string | null
}

type ParkIdentityCluster = {
    profileClusterKey: string
    profileKeys: string[]
    contactIds: string[]
    contactMergeCandidateIds: string[]
    warnings: string[]
    driverIds: string[]
    displayNames: string[]
}

type MutableParkIdentityCluster = {
    profileKeys: Set<string>
    contactIds: Set<string>
    contactMergeCandidateIds: Set<string>
    warnings: Set<string>
    driverIds: Set<string>
    displayNames: Set<string>
}

function nonEmpty(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
}

function parkCheckStatus(search: ParkPhoneSearchResultV1): ContactParkCheckStatusV1 {
    if (search.checkedParks === 0) return 'failed'
    if (search.errors.length === 0) return 'complete'
    const failedParkIds = new Set(search.errors.map(error => error.parkId).filter(nonEmpty))
    return failedParkIds.size >= search.checkedParks ? 'failed' : 'partial'
}

function aggregateParkIdentityClusters(search: ParkPhoneSearchResultV1): ParkIdentityCluster[] {
    const mutable = new Map<string, MutableParkIdentityCluster>()
    for (const park of search.results) {
        for (const profile of park.profiles) {
            // Provider profile IDs are park-scoped. Only a reconciler-issued
            // physical-person cluster key may intentionally join two parks.
            const profileClusterKey = nonEmpty(profile.profileClusterKey)
                ? profile.profileClusterKey
                : `park-profile:${park.parkId}:${profile.id}`
            const cluster = mutable.get(profileClusterKey) ?? {
                profileKeys: new Set<string>(),
                contactIds: new Set<string>(),
                contactMergeCandidateIds: new Set<string>(),
                warnings: new Set<string>(),
                driverIds: new Set<string>(),
                displayNames: new Set<string>(),
            }
            cluster.profileKeys.add(`${park.parkId}:${profile.id}`)
            if (nonEmpty(profile.contactId)) cluster.contactIds.add(profile.contactId)
            if (nonEmpty(profile.driverId)) cluster.driverIds.add(profile.driverId)
            if (nonEmpty(profile.fullName)) cluster.displayNames.add(profile.fullName)
            for (const candidateId of profile.contactMergeCandidateIds ?? []) {
                if (nonEmpty(candidateId)) cluster.contactMergeCandidateIds.add(candidateId)
            }
            for (const warning of profile.clusterWarnings ?? []) {
                if (nonEmpty(warning)) cluster.warnings.add(warning)
            }
            mutable.set(profileClusterKey, cluster)
        }
    }
    return [...mutable.entries()]
        .map(([profileClusterKey, cluster]) => ({
            profileClusterKey,
            profileKeys: [...cluster.profileKeys].sort(),
            contactIds: [...cluster.contactIds].sort(),
            contactMergeCandidateIds: [...cluster.contactMergeCandidateIds].sort(),
            warnings: [...cluster.warnings].sort(),
            driverIds: [...cluster.driverIds].sort(),
            displayNames: [...cluster.displayNames].sort((left, right) => left.localeCompare(right, 'ru')),
        }))
        .sort((left, right) => left.profileClusterKey.localeCompare(right.profileClusterKey))
}

function clusterDisplayName(cluster: ParkIdentityCluster): string | null {
    return cluster.displayNames.find(name => name !== 'Без имени') ?? cluster.displayNames[0] ?? null
}

async function persistParkCheck(contactId: string, parkCheckResult: ContactParkCheckSnapshotV1): Promise<void> {
    await persistContactParkCheckResultV1(contactId, parkCheckResult)
        .catch(error => console.error('[contact-parks] Failed to persist park check result:', error))
}

/** Check exact active contact phones across configured Fleet parks. */
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    if (!isExactSameOriginMutationRequest(request)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (!await getIntegrationAdminPrincipal()) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const context = await getContactParkCheckContextV1(id)
    if (!context) {
        return NextResponse.json({ error: 'CONTACT_NOT_FOUND', message: 'Контакт не найден' }, { status: 404 })
    }

    const linkedDriverPhone = await getParkLinkedDriverPhoneV1(context.yandexDriverId)
    const normalizedPhones = [...new Set([...context.activePhones, linkedDriverPhone || '']
        .map(normalizeParkPhoneDigitsV1)
        .filter(value => value.length >= 10))]
    const phones = normalizedPhones.map(value => `+${value}`)
    if (phones.length === 0) {
        return NextResponse.json({ error: 'PHONE_REQUIRED', message: 'В профиле нет телефона для проверки' }, { status: 422 })
    }

    let search = await searchYandexParksByPhonesV1(phones)
    let checkStatus = parkCheckStatus(search)
    let identityClusters = aggregateParkIdentityClusters(search)
    let effectiveContactId = id
    let automaticMerge: Awaited<ReturnType<typeof attemptAutomaticContactMergeFromPlatformV1>> | null = null
    let automaticMergeAttempted = false
    if (search.checkedParks === 0) {
        const message = 'Не настроены подключения к паркам'
        const parkCheckResult = {
            checkStatus,
            checkedAt: new Date().toISOString(),
            checkedPhones: phones,
            checkedParks: 0,
            foundProfiles: 0,
            results: search.results,
            errors: search.errors,
            identityClusters,
            driverLink: {
                status: 'error',
                contactId: id,
                driverId: null,
                displayName: null,
                message,
            } satisfies DriverLinkResult,
        }
        await persistParkCheck(id, parkCheckResult)
        return NextResponse.json({ error: 'NO_PARKS', message, ...parkCheckResult }, { status: 503 })
    }

    const exactCandidateCluster = checkStatus === 'complete' && identityClusters.length === 1
        ? identityClusters[0]
        : null
    const nonCandidateWarnings = exactCandidateCluster?.warnings
        .filter(warning => warning !== 'contact_auto_merge_candidate') ?? []
    if (exactCandidateCluster
        && exactCandidateCluster.contactMergeCandidateIds.length === 2
        && exactCandidateCluster.contactMergeCandidateIds.includes(id)
        && nonCandidateWarnings.length === 0) {
        automaticMergeAttempted = true
        try {
            automaticMerge = await attemptAutomaticContactMergeFromPlatformV1(
                exactCandidateCluster.contactMergeCandidateIds[0],
                exactCandidateCluster.contactMergeCandidateIds[1],
            )
            if (automaticMerge.status === 'merged' && automaticMerge.survivorContactId) {
                effectiveContactId = automaticMerge.survivorContactId
                // One bounded rerun applies the newly canonical Contact owner
                // through the same Fleet reconciliation algorithm.
                search = await searchYandexParksByPhonesV1(phones)
                checkStatus = parkCheckStatus(search)
                identityClusters = aggregateParkIdentityClusters(search)
            }
        } catch (error) {
            console.error('[contact-parks] Exact-pair automatic reconciliation failed:', error)
        }
    }

    const cleanForeignOwnerCluster = checkStatus === 'complete'
        && identityClusters.length === 1
        && identityClusters[0].warnings.length === 0
        && identityClusters[0].contactMergeCandidateIds.length === 0
        && identityClusters[0].contactIds.length === 1
        && identityClusters[0].contactIds[0] !== effectiveContactId
        ? identityClusters[0]
        : null
    if (!automaticMergeAttempted && cleanForeignOwnerCluster) {
        automaticMergeAttempted = true
        try {
            automaticMerge = await attemptAutomaticContactMergeFromPlatformV1(
                effectiveContactId,
                cleanForeignOwnerCluster.contactIds[0],
            )
            if (automaticMerge.status === 'merged' && automaticMerge.survivorContactId) {
                effectiveContactId = automaticMerge.survivorContactId
                // Every successful merge consumes the same single bounded
                // Fleet rerun before a durable park snapshot is composed.
                search = await searchYandexParksByPhonesV1(phones)
                checkStatus = parkCheckStatus(search)
                identityClusters = aggregateParkIdentityClusters(search)
            }
        } catch (error) {
            console.error('[contact-parks] Single-owner automatic reconciliation failed:', error)
        }
    }

    let driverLink: DriverLinkResult
    if (checkStatus === 'failed') {
        const cluster = identityClusters.length === 1 ? identityClusters[0] : null
        driverLink = {
            status: 'error',
            contactId: effectiveContactId,
            driverId: cluster?.driverIds[0] ?? null,
            displayName: cluster ? clusterDisplayName(cluster) : null,
            message: 'Проверка парков не завершена. Предыдущие данные сохранены; повторите попытку.',
        }
    } else if (checkStatus === 'partial') {
        const cluster = identityClusters.length === 1 ? identityClusters[0] : null
        driverLink = {
            status: identityClusters.length > 1 ? 'ambiguous' : 'review_required',
            contactId: effectiveContactId,
            driverId: cluster?.driverIds[0] ?? null,
            displayName: cluster ? clusterDisplayName(cluster) : null,
            message: 'Часть парков недоступна. Результат не используется для автоматической привязки или объединения.',
        }
    } else if (identityClusters.length === 0) {
        driverLink = { status: 'not_found', contactId: effectiveContactId, driverId: null, displayName: null, message: null }
    } else if (identityClusters.length > 1) {
        driverLink = {
            status: 'ambiguous',
            contactId: effectiveContactId,
            driverId: null,
            displayName: null,
            message: 'По телефонам найдены разные водители. Автоматическая привязка отменена.',
        }
    } else {
        const cluster = identityClusters[0]
        const displayName = clusterDisplayName(cluster)
        const driverId = cluster.driverIds[0] ?? null
        try {
            if (cluster.warnings.length > 0 || cluster.contactMergeCandidateIds.length > 0 || cluster.contactIds.length > 1) {
                driverLink = {
                    status: 'review_required',
                    contactId: effectiveContactId,
                    driverId,
                    displayName,
                    message: 'Данные профилей содержат противоречие или кандидатов на объединение. Нужна ручная сверка.',
                }
            } else if (cluster.contactIds.length === 0) {
                driverLink = {
                    status: 'review_required',
                    contactId: effectiveContactId,
                    driverId,
                    displayName,
                    message: 'Водитель найден. Для привязки подтвердите «Это он».',
                }
            } else if (cluster.contactIds[0] === effectiveContactId) {
                driverLink = {
                    status: automaticMerge?.status === 'merged' ? 'merged' : 'already_linked',
                    contactId: effectiveContactId,
                    driverId,
                    displayName,
                    message: null,
                }
            } else if (automaticMergeAttempted) {
                // The one permitted merge and Fleet rerun have already been
                // consumed. A different clean owner after that rerun is new
                // contradictory evidence, not proof that the prior survivor
                // owns this physical-person cluster.
                driverLink = {
                    status: 'ambiguous',
                    contactId: effectiveContactId,
                    driverId,
                    displayName,
                    message: 'После объединения парк вернул другого владельца контакта. Нужна ручная сверка.',
                }
            } else {
                driverLink = {
                    status: 'ambiguous',
                    contactId: effectiveContactId,
                    driverId,
                    displayName,
                    message: 'Водитель найден у другого контакта. Автообъединение недоступно; нужна ручная сверка.',
                }
            }
        } catch (error) {
            console.error('[contact-parks] Driver link failed:', error)
            driverLink = {
                status: 'error',
                contactId: effectiveContactId,
                driverId,
                displayName,
                message: 'Водитель найден, но сверку контакта не удалось завершить',
            }
        }
    }

    const parkCheckResult = {
        checkStatus,
        checkedAt: new Date().toISOString(),
        checkedPhones: phones,
        checkedParks: search.checkedParks,
        foundProfiles: search.results.reduce((total, park) => total + park.profiles.length, 0),
        results: search.results,
        errors: search.errors,
        identityClusters,
        driverLink,
        ...(automaticMerge ? { automaticMerge } : {}),
    }
    await persistParkCheck(driverLink.contactId || id, parkCheckResult)

    return NextResponse.json(parkCheckResult)
}
