import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { buildCanonicalContactSummary } from '@/modules/contacts/public/v1/contact-display-policy'
import { ContactService } from '@/lib/ContactService'
import { resolveContactLineageV1 } from '@/modules/contacts/public/v1'
import type { Prisma } from '@prisma/client'
import {
  contactAutomationState,
  identityEvidenceState,
  phoneEvidenceState,
} from '@/modules/contacts/public/v1/contact-evidence-state'
import {
  getIntegrationAdminPrincipal,
  isExactSameOriginMutationRequest,
} from '@/modules/identity-access/public/v1'

function driverFleetReadModel(customFields: unknown) {
  const fields = customFields && typeof customFields === 'object' && !Array.isArray(customFields)
    ? customFields as Record<string, unknown>
    : {}
  const source = fields.fleetSource && typeof fields.fleetSource === 'object' && !Array.isArray(fields.fleetSource)
    ? fields.fleetSource as Record<string, unknown>
    : {}
  const metadata = source.sourceMetadata && typeof source.sourceMetadata === 'object' && !Array.isArray(source.sourceMetadata)
    ? source.sourceMetadata as Record<string, unknown>
    : {}
  return {
    legalRole: typeof source.legalRole === 'string' ? source.legalRole : null,
    workStatus: typeof source.workStatus === 'string'
      ? source.workStatus
      : typeof source.sourceStatus === 'string' ? source.sourceStatus : null,
    currentStatus: typeof source.currentStatus === 'string'
      ? source.currentStatus
      : typeof source.sourceStatus === 'string' ? source.sourceStatus : null,
    sourceStatus: typeof source.sourceStatus === 'string' ? source.sourceStatus : null,
    sourceCity: typeof source.sourceCity === 'string' ? source.sourceCity : null,
    sourceProfileType: typeof source.sourceProfileType === 'string' ? source.sourceProfileType : null,
    sourcePhones: Array.isArray(source.sourcePhones) ? source.sourcePhones : [],
    sourceDates: source.sourceDates && typeof source.sourceDates === 'object' ? source.sourceDates : {},
    lastObservedAt: typeof source.lastObservedAt === 'string' ? source.lastObservedAt : null,
    lastSynchronizedAt: typeof source.lastSynchronizedAt === 'string' ? source.lastSynchronizedAt : null,
    sourceFreshness: typeof source.sourceFreshness === 'string' ? source.sourceFreshness : 'unknown',
    sourceState: typeof source.sourceState === 'string' ? source.sourceState : 'unknown',
    sourceMetadata: metadata,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
          orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
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
          orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
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
        driverProfiles: {
          orderBy: { createdAt: 'desc' },
          include: {
            park: { select: { id: true, parkName: true, externalParkId: true } },
          },
        },
        mainDriver: true,
      },
    })

    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }
    if (contact.isArchived) {
      const survivorId = contactAutomationState(contact.customFields).mergedIntoContactId
        || contact.mergesAsMerged.find(merge => merge.action === 'merge')?.survivorId
      if (survivorId) {
        return NextResponse.redirect(new URL(`/api/contacts/${survivorId}`, req.url), 308)
      }
      return NextResponse.json({ error: 'Contact archived', redirectContactId: null }, { status: 410 })
    }

    const lineage = await resolveContactLineageV1(contact.id)
    const redirectedProfiles = lineage && lineage.contactIds.length > 1
      ? await prisma.driver.findMany({
          where: { contactId: { in: lineage.contactIds.filter(contactId => contactId !== contact.id) } },
          orderBy: { createdAt: 'desc' },
          include: { park: { select: { id: true, parkName: true, externalParkId: true } } },
        })
      : []
    const allDriverProfiles = [...new Map(
      [...contact.driverProfiles, ...redirectedProfiles].map(profile => [profile.id, profile]),
    ).values()]

    // Fetch Driver if linked
    const driver = contact.mainDriver
      || allDriverProfiles.find(profile => driverFleetReadModel(profile.customFields).sourceState === 'current')
      || allDriverProfiles[0]
      || null

    const mergeHistory = [
      ...contact.mergesAsSurvivor.map(m => ({ ...m, role: 'survivor' as const })),
      ...contact.mergesAsMerged.map(m => ({ ...m, role: 'merged' as const })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    const customFields = contact.customFields && typeof contact.customFields === 'object' && !Array.isArray(contact.customFields)
      ? contact.customFields as Record<string, unknown>
      : {}
    const automationState = contactAutomationState(customFields)
    const driverConfirmations = Array.isArray(customFields.driverConfirmations)
      ? customFields.driverConfirmations
      : []
    const identityConflicts = Array.isArray(customFields.identityConflicts)
      ? customFields.identityConflicts.filter(item => (
          !item || typeof item !== 'object' || Array.isArray(item)
            ? false
            : (item as Record<string, unknown>).status === 'open'
        ))
      : []
    const channelIdentities = contact.identities.map(identity => {
      const metadata = identity.metadata && typeof identity.metadata === 'object' && !Array.isArray(identity.metadata)
        ? identity.metadata as Record<string, unknown>
        : {}
      return {
        ...identity,
        ...identityEvidenceState(identity.metadata),
        aliases: Array.isArray(metadata.providerAliases) ? metadata.providerAliases : [],
        conflicts: identityConflicts.filter(item => (
          item && typeof item === 'object' && !Array.isArray(item)
          && (item as Record<string, unknown>).identityId === identity.id
        )),
      }
    })
    const identities = channelIdentities.filter(identity => identity.isActive)
    const driverProfiles = allDriverProfiles.map(profile => {
      const evidence = driverFleetReadModel(profile.customFields)
      return {
        ...profile,
        ...evidence,
        normalizedVu: profile.personKeyType === 'normalized_vu'
          && profile.externalPersonKey?.startsWith('vu:')
          ? profile.externalPersonKey.slice(3)
          : null,
        sourceConflict: evidence.sourceMetadata.authoritativeContradiction ?? null,
        licenseObservations: Array.isArray(evidence.sourceMetadata.licenseHistory)
          ? evidence.sourceMetadata.licenseHistory
          : [],
      }
    })
    const phones = contact.phones.map(phone => ({
      ...phone,
      ...phoneEvidenceState(contact.customFields, phone.id, phone),
    }))

    return NextResponse.json({
      id: contact.id,
      displayName: contact.displayName,
      displayNameSource: contact.displayNameSource,
      masterSource: contact.masterSource,
      yandexDriverId: contact.yandexDriverId,
      primaryPhoneId: contact.primaryPhoneId,
      notes: contact.notes,
      tags: contact.tags,
      customFields,
      isArchived: contact.isArchived,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      phones,
      identities,
      channelIdentities,
      chats: contact.chats,
      driver,
      driverProfiles,
      driverConfirmations,
      identityConflicts,
      driverSummary: {
        profileCount: allDriverProfiles.length,
        parkCount: new Set(allDriverProfiles.map(profile => profile.externalParkId).filter(Boolean)).size,
        staleCount: allDriverProfiles.filter(profile => (
          driverFleetReadModel(profile.customFields).sourceFreshness !== 'fresh'
        )).length,
        failedCount: allDriverProfiles.filter(profile => (
          driverFleetReadModel(profile.customFields).sourceState === 'failed'
        )).length,
      },
      canonicalSummary: buildCanonicalContactSummary({
        contact: {
          ...contact,
          ...automationState,
          phones,
          identities,
          driverConfirmations,
        },
        driver,
        currentChannel: contact.chats[0]?.channel || null,
      }),
      mergeHistory,
    })
  } catch (err: unknown) {
    console.error('[contacts/:id] GET Error:', errorMessage(err))
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

/**
 * PATCH /api/contacts/:id
 *
 * Обновляемые поля: displayName, primaryPhoneId, tags, notes.
 * customFields is owner-managed evidence and cannot be replaced wholesale.
 * displayName → displayNameSource = "manual".
 * masterSource и yandexDriverId НЕ редактируются.
 *
 * Spec: unified-contact-spec.md v1.1 §12.2
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isExactSameOriginMutationRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (!await getIntegrationAdminPrincipal()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    const input: unknown = await req.json()
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return NextResponse.json({ error: 'INVALID_BODY' }, { status: 400 })
    }
    const body = input as Record<string, unknown>

    // Block immutable fields
    if ('masterSource' in body || 'yandexDriverId' in body) {
      return NextResponse.json(
        { error: 'IMMUTABLE_FIELD', message: 'masterSource and yandexDriverId cannot be changed via PATCH' },
        { status: 400 }
      )
    }
    if ('customFields' in body) {
      return NextResponse.json(
        {
          error: 'CUSTOM_FIELDS_REPLACEMENT_FORBIDDEN',
          message: 'customFields cannot be replaced wholesale via PATCH',
        },
        { status: 400 },
      )
    }

    const data: Prisma.ContactUncheckedUpdateInput = {}

    if ('displayName' in body && typeof body.displayName === 'string' && body.displayName.trim()) {
      data.displayName = body.displayName.trim()
      data.displayNameSource = 'manual'
    }

    if ('primaryPhoneId' in body) {
      data.primaryPhoneId = typeof body.primaryPhoneId === 'string' && body.primaryPhoneId
        ? body.primaryPhoneId
        : null
    }

    if ('tags' in body && Array.isArray(body.tags)) {
      data.tags = body.tags.filter((tag): tag is string => typeof tag === 'string')
    }

    if ('notes' in body) {
      data.notes = typeof body.notes === 'string' ? body.notes : null
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: 'NO_CHANGES', message: 'No valid fields to update' },
        { status: 400 }
      )
    }

    let updated
    if ('primaryPhoneId' in body) {
      updated = await ContactService.patchContact(id, data)
    } else {
      const existing = await prisma.contact.findUnique({
        where: { id },
        select: { id: true, isArchived: true },
      })
      updated = !existing || existing.isArchived
        ? null
        : await prisma.contact.update({
          where: { id },
          data: {
            displayName: data.displayName,
            displayNameSource: data.displayNameSource,
            tags: data.tags,
            notes: data.notes,
          },
        }).catch((error: { code?: string }) => {
          if (error?.code === 'P2025') return null
          throw error
        })
    }
    if (updated === null) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }
    if (typeof updated === 'boolean') {
      return NextResponse.json(
        { error: 'INVALID_PHONE_ID', message: 'Phone does not belong to this contact' },
        { status: 400 },
      )
    }

    return NextResponse.json({
      id: updated.id,
      displayName: updated.displayName,
      displayNameSource: updated.displayNameSource,
      masterSource: updated.masterSource,
      primaryPhoneId: updated.primaryPhoneId,
      tags: updated.tags,
      notes: updated.notes,
      customFields: updated.customFields,
      updatedAt: updated.updatedAt,
    })
  } catch (err: unknown) {
    console.error('[contacts/:id] PATCH Error:', errorMessage(err))
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
