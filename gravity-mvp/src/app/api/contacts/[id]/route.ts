/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { chooseMainDriverProfile, findSuggestedDriverProfilesForContact, getDriverProfileStatus, normalizeParkName } from '@/lib/driver-profiles/multi-park'
import { buildCanonicalContactSummary } from '@/lib/contact-display'
import {
  CONTACT_PROFILE_SCHEMA_VERSION,
  deriveDriverProfileState,
  type ContactProfileAnomalyPayload,
} from '@/lib/contact-profile-contract'
import {
  getDriverProfileStatusLabel,
  getEmploymentTypeLabel,
  getSuggestionBasis,
  groupDriverProfilesByPark,
} from '@/lib/contact-profile-ui'
import { formatProfileRefreshWarning, getContactProfileRefreshDecision } from '@/lib/driver-profiles/refresh-policy'
import { deriveTelegramBotProfileState } from '@/lib/telegram-bot-profile-state'
import { resolveCanonicalContactId } from '@/lib/contacts/canonical-contact'
import { buildYandexDispatcherTarget } from '@/lib/driver-profiles/dispatcher-links'

const PROFILE_CHANNELS = ['max', 'whatsapp', 'telegram'] as const

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function dateOrNull(value: unknown): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

function dateIsoOrNull(value: unknown): string | null {
  return dateOrNull(value)?.toISOString() ?? null
}

function latestDate(values: Array<Date | null | undefined>): Date | null {
  return values.reduce<Date | null>((latest, value) => {
    if (!value) return latest
    return !latest || value.getTime() > latest.getTime() ? value : latest
  }, null)
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ')
}

/**
 * GET /api/contacts/:id
 *
 * Полная карточка контакта: phones, identities, chats, driver, mergeHistory.
 * Spec: unified-contact-spec.md v1.1 §12.2 (API contracts)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    const contact = await prisma.contact.findUnique({
      where: { id },
      include: {
        phones: {
          where: { isActive: true },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            phone: true,
            label: true,
            isPrimary: true,
            source: true,
            isActive: true,
            verifiedAt: true,
            isTemporary: true,
            expiresAt: true,
            createdAt: true,
          },
        },
        identities: {
          where: { isActive: true },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            channel: true,
            externalId: true,
            phoneId: true,
            displayName: true,
            source: true,
            confidence: true,
            isActive: true,
            createdAt: true,
            reachabilityStatus: true,
            reachabilityCheckedAt: true,
            metadata: true,
          },
        },
        chats: {
          orderBy: { lastMessageAt: 'desc' },
          select: {
            id: true,
            channel: true,
            externalChatId: true,
            contactIdentityId: true,
            lastMessageAt: true,
            unreadCount: true,
            status: true,
            name: true,
          },
        },
        mergesAsSurvivor: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            mergedId: true,
            action: true,
            mergedBy: true,
            reason: true,
            createdAt: true,
          },
        },
        mergesAsMerged: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            survivorId: true,
            action: true,
            mergedBy: true,
            reason: true,
            createdAt: true,
          },
        },
      },
    })

    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }
    if (contact.isArchived) {
      const canonical = await resolveCanonicalContactId(id)
      if (canonical.kind === 'resolved' && canonical.canonicalContactId !== id) {
        return NextResponse.json({
          status: 'merged_contact',
          code: 'CONTACT_MERGED',
          originalContactId: id,
          canonicalContactId: canonical.canonicalContactId,
          location: `/api/contacts/${canonical.canonicalContactId}`,
        }, { status: 409 })
      }
      return NextResponse.json({
        error: 'Archived Contact has no safe canonical redirect',
        code: canonical.kind === 'ambiguous'
          ? 'CONTACT_MERGE_AMBIGUOUS'
          : canonical.kind === 'cycle'
            ? 'CONTACT_MERGE_CYCLE'
            : 'CONTACT_ARCHIVED_WITHOUT_REDIRECT',
        contactId: id,
      }, { status: 409 })
    }

    const profileSelect = {
      id: true,
      yandexDriverId: true,
      externalDriverProfileId: true,
      externalParkId: true,
      fullName: true,
      phone: true,
      licenseNumber: true,
      lastExternalPark: true,
      lastFleetCheckAt: true,
      lastFleetCheckStatus: true,
      segment: true,
      score: true,
      lastOrderAt: true,
      hiredAt: true,
      dismissedAt: true,
      statusOverride: true,
      contactId: true,
      personResolutionStatus: true,
      personResolutionBasis: true,
      externalPersonKey: true,
      parkId: true,
      park: { select: { parkCode: true, parkName: true } },
      sourceConnectionId: true,
      customFields: true,
      updatedAt: true,
    }

    const profileCandidates = await prisma.driver.findMany({
      where: {
        OR: [
          { contactId: contact.id },
          ...(contact.yandexDriverId ? [{ yandexDriverId: contact.yandexDriverId }] : []),
        ],
      },
      select: profileSelect,
      orderBy: [{ dismissedAt: 'asc' }, { lastExternalPark: 'asc' }, { fullName: 'asc' }],
    })
    const profileMap = new Map(profileCandidates.map(profile => [profile.id, profile]))
    const uniqueProfileCandidates = Array.from(profileMap.values())
    const mainDecision = chooseMainDriverProfile(uniqueProfileCandidates, contact.mainDriverSelection === 'manual' ? contact.mainDriverId : null)
    const suggestedDriverProfiles = await findSuggestedDriverProfilesForContact(contact.id)
    const mainDriverId = contact.mainDriverId || mainDecision.main?.id || null

    const parkConnections = await prisma.parkConnection.findMany({
      where: { enabled: true, archivedAt: null },
      select: {
        parkId: true,
        apiConnectionId: true,
        externalParkId: true,
        lastSuccessfulSyncAt: true,
        lastFailedSyncAt: true,
        lastErrorSummary: true,
        park: { select: { parkCode: true, parkName: true } },
      },
      orderBy: { park: { parkName: 'asc' } },
    })
    const syncForProfile = (profile: any) => parkConnections.find(connection =>
      (profile.sourceConnectionId && connection.apiConnectionId === profile.sourceConnectionId && connection.externalParkId === profile.externalParkId)
      || (profile.parkId && connection.parkId === profile.parkId)
      || (profile.externalParkId && connection.externalParkId === profile.externalParkId)
    ) || null

    const conflictContactIds = Array.from(new Set(suggestedDriverProfiles.map(profile => profile.conflictContactId).filter((value): value is string => Boolean(value))))
    const conflictContacts = conflictContactIds.length > 0
      ? await prisma.contact.findMany({
          where: { id: { in: conflictContactIds }, isArchived: false },
          select: {
            id: true,
            displayName: true,
            chats: { orderBy: { lastMessageAt: 'desc' }, take: 1, select: { id: true } },
          },
        })
      : []
    const conflictsById = new Map(conflictContacts.map(item => [item.id, {
      id: item.id,
      displayName: item.displayName,
      chatId: item.chats[0]?.id ?? null,
    }]))

    const toProfilePayload = (profile: any, isMain: boolean) => {
      const customFields = asRecord(profile.customFields)
      const yandexProfile = asRecord(customFields.yandexProfile)
      const connection = syncForProfile(profile)
      const conflictContactId = profile.conflictContactId || (profile.contactId && profile.contactId !== contact.id ? profile.contactId : null)
      const sourceUpdatedAt = dateOrNull(yandexProfile.sourceUpdatedAt) || profile.lastFleetCheckAt || profile.updatedAt || null
      const employmentTypeCode = stringOrNull(yandexProfile.employmentType)
      const normalizedStatus = profile.status || getDriverProfileStatus(profile)
      const matchedSignals = profile.matchedSignals || []
      const suggestionBasis = getSuggestionBasis(matchedSignals)
      const linkedContactSummary = conflictContactId ? conflictsById.get(conflictContactId) ?? null : null
      return {
        id: profile.id,
        yandexDriverId: profile.yandexDriverId,
        externalDriverProfileId: profile.externalDriverProfileId ?? null,
        externalParkId: profile.externalParkId ?? null,
        fullName: profile.fullName,
        phone: profile.phone ?? null,
        licenseNumber: profile.licenseNumber ?? null,
        lastExternalPark: profile.lastExternalPark ?? null,
        parkCode: profile.parkCode ?? profile.park?.parkCode ?? connection?.park.parkCode ?? null,
        parkName: normalizeParkName(profile.parkName || profile.park?.parkName || connection?.park.parkName || profile.lastExternalPark),
        employmentTypeCode,
        employmentTypeLabel: getEmploymentTypeLabel(employmentTypeCode),
        employmentType: employmentTypeCode,
        workStatus: stringOrNull(yandexProfile.sourceWorkStatus) || stringOrNull(yandexProfile.workStatus),
        currentStatus: profile.lastFleetCheckStatus ?? stringOrNull(yandexProfile.sourceCurrentStatus) ?? stringOrNull(yandexProfile.currentStatus),
        segment: profile.segment || 'unknown',
        score: profile.score ?? null,
        status: normalizedStatus,
        normalizedStatus,
        statusLabel: getDriverProfileStatusLabel(normalizedStatus),
        isMain,
        contactId: profile.contactId ?? null,
        conflictContactId,
        conflictContact: linkedContactSummary,
        linkedContactConflict: Boolean(conflictContactId),
        linkedContactSummary,
        matchedSignals,
        suggestionBasis: suggestionBasis.code,
        suggestionBasisLabel: suggestionBasis.label,
        personResolutionStatus: profile.personResolutionStatus || 'unlinked',
        personResolutionBasis: profile.personResolutionBasis ?? null,
        externalPersonKey: profile.externalPersonKey ?? null,
        lastOrderAt: dateIsoOrNull(profile.lastOrderAt),
        hiredAt: dateIsoOrNull(profile.hiredAt),
        dismissedAt: dateIsoOrNull(profile.dismissedAt),
        sourceUpdatedAt: dateIsoOrNull(sourceUpdatedAt),
        lastSuccessfulSyncAt: dateIsoOrNull(connection?.lastSuccessfulSyncAt),
        lastFailedSyncAt: dateIsoOrNull(connection?.lastFailedSyncAt),
        dispatcher: buildYandexDispatcherTarget({
          profile: {
            externalDriverProfileId: profile.externalDriverProfileId ?? null,
            externalParkId: profile.externalParkId ?? null,
            phone: profile.phone ?? null,
            parkName: profile.parkName || profile.park?.parkName || profile.lastExternalPark || null,
          },
          connection: connection
            ? {
                externalParkId: connection.externalParkId,
                park: connection.park,
              }
            : null,
          configuredBaseUrl: process.env.YANDEX_DISPATCHER_BASE_URL,
        }),
      }
    }

    const attachedProfiles = uniqueProfileCandidates.map(profile => toProfilePayload(profile, profile.id === mainDriverId))
    const suggestedProfiles = suggestedDriverProfiles.map(profile => toProfilePayload(profile, false))
    const mainDriverProfile = attachedProfiles.find(profile => profile.id === mainDriverId)
      || attachedProfiles.find(profile => profile.id === mainDecision.main?.id)
      || null

    const contactTelegramIdentity = contact.identities.find(identity => identity.channel === 'telegram') || null
    const contactTelegramMetadata = asRecord(contactTelegramIdentity?.metadata)
    const metadataTelegramUserId = stringOrNull(contactTelegramMetadata.telegramUserId)
    const identityExternalId = contactTelegramIdentity?.externalId || null
    const identityExternalIdIsPhone = Boolean(identityExternalId && /^[78]\d{10}$/.test(identityExternalId))
    const contactTelegramUserId = metadataTelegramUserId
      || (identityExternalId && !identityExternalIdIsPhone ? identityExternalId : null)
    const contactTelegramIdValue = contactTelegramUserId && /^\d+$/.test(contactTelegramUserId)
      ? BigInt(contactTelegramUserId)
      : null
    type TelegramBotLink = Awaited<ReturnType<typeof prisma.driverTelegram.findMany>>[number]
    let telegramBotLinks: TelegramBotLink[] = []
    let telegramBotLookupAvailable = true
    try {
      telegramBotLinks = attachedProfiles.length > 0 || contactTelegramIdValue
        ? await prisma.driverTelegram.findMany({
            where: {
              OR: [
                ...(attachedProfiles.length > 0
                  ? [{ driverId: { in: attachedProfiles.map(profile => profile.id) } }]
                  : []),
                ...(contactTelegramIdValue
                  ? [{ telegramId: contactTelegramIdValue }]
                  : []),
              ],
            },
            orderBy: { createdAt: 'desc' },
          })
        : []
    } catch (telegramBotLookupError) {
      telegramBotLookupAvailable = false
      console.error('[contacts/:id] Telegram Bot lookup unavailable', {
        contactId: contact.id,
        error: telegramBotLookupError instanceof Error ? telegramBotLookupError.message : String(telegramBotLookupError),
      })
    }
    const telegramBotLink = telegramBotLinks[0] || null
    const telegramBotProfile = telegramBotLink
      ? attachedProfiles.find(profile => profile.id === telegramBotLink.driverId) || null
      : null
    const telegramUserId = telegramBotLink?.telegramId.toString() || contactTelegramUserId
    const telegramUsername = telegramBotLink?.username || stringOrNull(contactTelegramMetadata.username)
    const lastObservedUsername = stringOrNull(contactTelegramMetadata.lastObservedUsername) || telegramUsername
    const lastObservedAt = dateIsoOrNull(contactTelegramMetadata.lastObservedAt)
      || dateIsoOrNull(contactTelegramIdentity?.createdAt)
    const lastSyncAt = dateIsoOrNull(contactTelegramMetadata.lastSyncAt)
      || dateIsoOrNull(contactTelegramIdentity?.reachabilityCheckedAt)
      || lastObservedAt
    const telegramIdentity = telegramUserId
      ? {
          telegramUserId,
          username: telegramUsername,
          displayName: contactTelegramIdentity?.displayName || null,
          source: telegramBotLink ? 'driver_telegram' as const : 'contact_identity' as const,
          lastObservedUsername,
          lastObservedAt,
          lastSyncAt,
          lastVerifiedAt: dateIsoOrNull(telegramBotLink?.createdAt) || lastSyncAt,
        }
      : null
    const telegramBotStatus = deriveTelegramBotProfileState({
      lookupAvailable: telegramBotLookupAvailable,
      linkCount: telegramBotLinks.length,
      hasTelegramIdentity: Boolean(contactTelegramUserId),
      linkedProfile: telegramBotProfile
        ? { id: telegramBotProfile.id, normalizedStatus: telegramBotProfile.normalizedStatus }
        : null,
      mainDriverId: mainDriverProfile?.id || null,
    })
    const telegramBotLastUpdatedAt = latestDate([
      telegramBotLink?.createdAt,
      dateOrNull(lastSyncAt),
      dateOrNull(lastObservedAt),
    ])
    const telegramBotState = {
      status: telegramBotStatus,
      linked: Boolean(telegramBotLink),
      telegramUserId,
      username: telegramUsername,
      driverProfile: telegramBotStatus === 'CONFLICT' || telegramBotStatus === 'TEMPORARILY_UNAVAILABLE'
        ? null
        : telegramBotProfile,
      activeParkId: telegramBotLink?.activeParkId || null,
      parkName: telegramBotProfile?.parkName || null,
      boundAt: dateIsoOrNull(telegramBotLink?.createdAt),
      lastUpdatedAt: dateIsoOrNull(telegramBotLastUpdatedAt),
      source: telegramBotLink ? 'driver_telegram' as const : contactTelegramUserId ? 'contact_identity' as const : 'none' as const,
      conflictCount: telegramBotLinks.length,
    }

    const currentSyncFailures = parkConnections.filter(connection =>
      Boolean(connection.lastErrorSummary)
      && Boolean(connection.lastFailedSyncAt)
      && (!connection.lastSuccessfulSyncAt || connection.lastFailedSyncAt!.getTime() > connection.lastSuccessfulSyncAt.getTime())
    )
    const refreshDecisionByConnection = new Map(currentSyncFailures.map(connection => [
      connection.apiConnectionId,
      getContactProfileRefreshDecision({
        lastSuccessfulAt: connection.lastSuccessfulSyncAt,
        lastFailedAt: connection.lastFailedSyncAt,
      }),
    ]))
    const latestSuccessfulSyncAt = latestDate(parkConnections.map(connection => connection.lastSuccessfulSyncAt))
    const latestFailedSyncAt = latestDate(parkConnections.map(connection => connection.lastFailedSyncAt))
    const syncState = {
      status: currentSyncFailures.length > 0 ? 'stale' as const : latestSuccessfulSyncAt ? 'ok' as const : 'never' as const,
      lastSuccessfulAt: latestSuccessfulSyncAt,
      lastFailedAt: latestFailedSyncAt,
      error: currentSyncFailures.map(connection => formatProfileRefreshWarning(connection.park.parkName)).join(' ') || null,
      parks: parkConnections.map(connection => {
        const decision = refreshDecisionByConnection.get(connection.apiConnectionId)
        return {
          parkCode: connection.park.parkCode,
          parkName: connection.park.parkName,
          lastSuccessfulAt: connection.lastSuccessfulSyncAt,
          lastFailedAt: connection.lastFailedSyncAt,
          error: decision ? formatProfileRefreshWarning(connection.park.parkName) : null,
          state: decision?.kind === 'backoff'
            ? 'backoff' as const
            : decision?.kind === 'stale'
              ? 'stale' as const
              : connection.lastSuccessfulSyncAt
                ? 'fresh' as const
                : 'never' as const,
          retryAt: decision?.retryAt || null,
          canRetry: decision?.kind !== 'backoff',
        }
      }),
    }

    const anomalies: ContactProfileAnomalyPayload[] = mainDecision.anomalies.map(anomaly => ({
      type: 'multiple_active_profiles_same_park',
      severity: 'warning',
      message: `В парке ${anomaly.park} найдено несколько активных профилей`,
      parkName: anomaly.park,
      profileIds: anomaly.driverIds,
    }))
    for (const group of groupDriverProfilesByPark([...attachedProfiles, ...suggestedProfiles])) {
      if (group.activeCount < 2) continue
      if (anomalies.some(anomaly => anomaly.type === 'multiple_active_profiles_same_park' && anomaly.parkName === group.parkName)) continue
      anomalies.push({
        type: 'multiple_active_profiles_same_park',
        severity: 'warning',
        message: `В парке ${group.parkName} найдено несколько активных профилей`,
        parkName: group.parkName,
        profileIds: group.active.filter(profile => profile.normalizedStatus === 'working').map(profile => profile.id),
      })
    }
    for (const profile of suggestedProfiles.filter(profile => profile.conflictContactId)) {
      anomalies.push({
        type: 'profile_belongs_to_other_contact',
        severity: 'error',
        message: `${profile.fullName}: профиль уже принадлежит другому Contact`,
        parkName: profile.parkName,
        profileIds: [profile.id],
        contactId: profile.conflictContactId || undefined,
      })
    }
    const candidateNames = Array.from(new Set([...attachedProfiles, ...suggestedProfiles].map(profile => normalizedName(profile.fullName))))
    if (candidateNames.length > 1) {
      anomalies.push({
        type: 'different_names',
        severity: 'warning',
        message: 'В профилях отличаются ФИО. Проверьте принадлежность одному человеку',
        profileIds: [...attachedProfiles, ...suggestedProfiles].map(profile => profile.id),
      })
    }
    const personKeys = new Set(suggestedProfiles.map(profile => profile.externalPersonKey).filter(Boolean))
    if (suggestedProfiles.length > 1 && (personKeys.size !== 1 || suggestedProfiles.some(profile => !profile.externalPersonKey))) {
      anomalies.push({
        type: 'person_ownership_ambiguous',
        severity: 'warning',
        message: 'Телефон совпал, но владение профилями требует ручного подтверждения',
        profileIds: suggestedProfiles.map(profile => profile.id),
      })
    }
    for (const connection of currentSyncFailures) {
      anomalies.push({
        type: 'sync_stale',
        severity: 'warning',
        message: formatProfileRefreshWarning(connection.park.parkName),
        parkName: connection.park.parkName,
        profileIds: [...attachedProfiles, ...suggestedProfiles].filter(profile => profile.parkCode === connection.park.parkCode).map(profile => profile.id),
      })
    }
    const driverProfileState = deriveDriverProfileState(
      attachedProfiles.length,
      suggestedProfiles.length,
      anomalies.filter(anomaly => anomaly.type !== 'sync_stale').length,
    )
    const primaryPhone = contact.phones.find(phone => phone.id === contact.primaryPhoneId) || contact.phones.find(phone => phone.isPrimary) || contact.phones[0] || null
    const channels = PROFILE_CHANNELS.map(channel => {
      const identity = contact.identities.find(item => item.channel === channel)
      return {
        channel,
        identityId: identity?.id ?? null,
        externalId: identity?.externalId ?? null,
        displayName: identity?.displayName ?? null,
        state: identity ? 'linked' as const : 'available_by_phone' as const,
      }
    })

    const driver = mainDriverProfile

    const canonicalSummary = buildCanonicalContactSummary({
      contact,
      profiles: attachedProfiles,
      currentChannel: contact.chats[0]?.channel || null,
      providerChannels: channels.map(channel => channel.channel),
    })

    const mergeHistory = [
      ...contact.mergesAsSurvivor.map(m => ({ ...m, role: 'survivor' as const })),
      ...contact.mergesAsMerged.map(m => ({ ...m, role: 'merged' as const })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

    return NextResponse.json({
      schemaVersion: CONTACT_PROFILE_SCHEMA_VERSION,
      id: contact.id,
      displayName: contact.displayName,
      displayNameSource: contact.displayNameSource,
      masterSource: contact.masterSource,
      yandexDriverId: contact.yandexDriverId,
      mainDriverId: contact.mainDriverId,
      mainDriverSelection: contact.mainDriverSelection,
      primaryPhoneId: contact.primaryPhoneId,
      primaryPhone,
      notes: contact.notes,
      tags: contact.tags,
      customFields: contact.customFields,
      isArchived: contact.isArchived,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      phones: contact.phones,
      identities: contact.identities,
      chats: contact.chats,
      channels,
      canonicalSummary,
      driverProfileState,
      suggestedProfiles,
      attachedProfiles,
      mainDriverProfile,
      syncState,
      anomalies,
      telegramIdentity,
      telegramBotState,
      technicalData: {
        contactId: contact.id,
        schemaVersion: CONTACT_PROFILE_SCHEMA_VERSION,
        buildMarker: process.env.APP_VERSION || process.env.GIT_COMMIT || 'dev',
        providerIds: contact.identities.map(identity => ({ channel: identity.channel, externalId: identity.externalId })),
        driverProfileIds: attachedProfiles.map(profile => profile.id),
        suggestedProfileIds: suggestedProfiles.map(profile => profile.id),
        resolutionState: driverProfileState,
        lastSuccessfulSyncAt: latestSuccessfulSyncAt,
        lastFailedSyncAt: latestFailedSyncAt,
        profileSourceValues: [...attachedProfiles, ...suggestedProfiles].map(profile => ({
          id: profile.id,
          employmentTypeCode: profile.employmentTypeCode,
          workStatusCode: profile.workStatus,
          currentStatusCode: profile.currentStatus,
        })),
        syncFailures: currentSyncFailures.map(connection => ({
          parkCode: connection.park.parkCode,
          failedAt: dateIsoOrNull(connection.lastFailedSyncAt),
          retryAt: dateIsoOrNull(refreshDecisionByConnection.get(connection.apiConnectionId)?.retryAt),
          rawError: connection.lastErrorSummary,
        })),
      },
      driver,
      mainDriver: mainDriverProfile,
      driverProfiles: attachedProfiles,
      profileAnomalies: mainDecision.anomalies,
      suggestedDriverProfiles: suggestedProfiles,
      mergeHistory,
    }, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'X-CRM-Contact-Profile-Schema': String(CONTACT_PROFILE_SCHEMA_VERSION),
      },
    })
  } catch (err: any) {
    console.error('[contacts/:id] GET Error:', err.message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

/**
 * PATCH /api/contacts/:id
 *
 * Обновляемые поля: displayName, primaryPhoneId, tags, notes, customFields.
 * displayName → displayNameSource = "manual".
 * masterSource и yandexDriverId НЕ редактируются.
 *
 * Spec: unified-contact-spec.md v1.1 §12.2
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await req.json()

    const contact = await prisma.contact.findUnique({ where: { id } })
    if (!contact || contact.isArchived) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    // Block immutable fields
    if ('masterSource' in body || 'yandexDriverId' in body) {
      return NextResponse.json(
        { error: 'IMMUTABLE_FIELD', message: 'masterSource and yandexDriverId cannot be changed via PATCH' },
        { status: 400 }
      )
    }

    const data: any = {}

    if ('displayName' in body && typeof body.displayName === 'string' && body.displayName.trim()) {
      data.displayName = body.displayName.trim()
      data.displayNameSource = 'manual'
    }

    if ('primaryPhoneId' in body) {
      if (body.primaryPhoneId) {
        // Validate phone belongs to this contact
        const phone = await prisma.contactPhone.findFirst({
          where: { id: body.primaryPhoneId, contactId: id, isActive: true },
        })
        if (!phone) {
          return NextResponse.json(
            { error: 'INVALID_PHONE_ID', message: 'Phone does not belong to this contact' },
            { status: 400 }
          )
        }
      }
      data.primaryPhoneId = body.primaryPhoneId || null
    }

    if ('tags' in body && Array.isArray(body.tags)) {
      data.tags = body.tags.filter((t: any) => typeof t === 'string')
    }

    if ('notes' in body) {
      data.notes = typeof body.notes === 'string' ? body.notes : null
    }

    if ('customFields' in body && typeof body.customFields === 'object') {
      data.customFields = body.customFields
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: 'NO_CHANGES', message: 'No valid fields to update' },
        { status: 400 }
      )
    }

    const updated = await prisma.contact.update({
      where: { id },
      data,
      select: {
        id: true,
        displayName: true,
        displayNameSource: true,
        masterSource: true,
        primaryPhoneId: true,
        tags: true,
        notes: true,
        customFields: true,
        updatedAt: true,
      },
    })

    return NextResponse.json(updated)
  } catch (err: any) {
    console.error('[contacts/:id] PATCH Error:', err.message)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
