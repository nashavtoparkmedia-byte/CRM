import { createHmac, timingSafeEqual } from 'crypto'
import { Prisma } from '@prisma/client'

import { ContactResolutionService } from '@/lib/contacts/ContactResolutionService'
import {
  findSuggestedDriverProfilesByPhone,
  PARK_PRIORITY,
  type SuggestedDriverProfile,
} from '@/lib/driver-profiles/multi-park'
import { normalizeRussianPhoneE164 } from '@/lib/phoneUtils'
import { prisma } from '@/lib/prisma'

const MAX_MERGE_DEPTH = 16
const TOKEN_TTL_MS = 5 * 60 * 1000

export type PhoneOwnershipStatus = 'FREE' | 'SAME_CONTACT' | 'OTHER_CONTACT' | 'AMBIGUOUS'

export type PhoneOwnershipContact = {
  id: string
  isArchived: boolean
}

export type PhoneMergeEdge = {
  survivor: PhoneOwnershipContact
}

export interface PhoneOwnershipRepository {
  findContact(contactId: string): Promise<PhoneOwnershipContact | null>
  findActivePhoneOwners(normalizedPhone: string): Promise<PhoneOwnershipContact[]>
  findMergeSurvivors(contactId: string): Promise<PhoneMergeEdge[]>
}

export type PhoneOwnershipEvaluation = {
  ownershipStatus: PhoneOwnershipStatus
  rawOwnerIds: string[]
  canonicalOwnerIds: string[]
  unsafeContactIds: string[]
  fingerprint: string
}

export type PhoneOwnerSummary = {
  id: string
  displayName: string
  phone: string
  channels: string[]
  mainDriverProfile: { id: string; fullName: string; parkName: string } | null
  driverProfileCount: number
  lastContactAt: string | null
  chatId: string | null
  isArchived: boolean
}

export type PhoneSuggestionSummary = {
  id: string
  fullName: string
  parkName: string
  status: SuggestedDriverProfile['status']
  conflictContactId: string | null
  matchedSignals: string[]
}

export type ContactPhonePreflight = {
  normalizedPhone: string
  ownershipStatus: PhoneOwnershipStatus
  resolutionStatus: 'PHONE_OWNERSHIP_AMBIGUOUS' | PhoneOwnershipStatus
  ownerContacts: PhoneOwnerSummary[]
  driverProfileSuggestions: PhoneSuggestionSummary[]
  searchedParks: readonly string[]
  canAdd: boolean
  canReviewMerge: boolean
  confirmationToken: string
}

type CanonicalResult =
  | { kind: 'canonical'; contactId: string }
  | { kind: 'unsafe'; contactIds: string[] }

type ConfirmationPayload = {
  version: 1
  contactId: string
  normalizedPhone: string
  ownershipStatus: PhoneOwnershipStatus
  fingerprint: string
  expiresAt: number
}

type PhoneResolutionDb = Prisma.TransactionClient

export class ContactPhoneResolutionError extends Error {
  constructor(
    public readonly code: 'INVALID_PHONE' | 'CONTACT_NOT_FOUND' | 'CONTACT_NOT_ACTIVE' | 'INVALID_CONFIRMATION_TOKEN',
    message: string,
  ) {
    super(message)
    this.name = 'ContactPhoneResolutionError'
  }
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

async function resolveCanonicalOwner(
  contact: PhoneOwnershipContact,
  repository: PhoneOwnershipRepository,
): Promise<CanonicalResult> {
  let current = contact
  const visited = [current.id]

  for (let depth = 0; depth < MAX_MERGE_DEPTH; depth += 1) {
    const edges = await repository.findMergeSurvivors(current.id)
    const survivors = new Map(edges.map(edge => [edge.survivor.id, edge.survivor]))

    if (survivors.size === 0) {
      return current.isArchived
        ? { kind: 'unsafe', contactIds: [current.id] }
        : { kind: 'canonical', contactId: current.id }
    }
    if (survivors.size > 1) {
      return { kind: 'unsafe', contactIds: sortedUnique([current.id, ...survivors.keys()]) }
    }

    const survivor = survivors.values().next().value as PhoneOwnershipContact
    if (visited.includes(survivor.id)) {
      return { kind: 'unsafe', contactIds: sortedUnique([...visited, survivor.id]) }
    }
    current = survivor
    visited.push(current.id)
  }

  return { kind: 'unsafe', contactIds: sortedUnique(visited) }
}

export async function classifyContactPhoneOwnership(
  contactId: string,
  normalizedPhone: string,
  repository: PhoneOwnershipRepository,
): Promise<PhoneOwnershipEvaluation> {
  const target = await repository.findContact(contactId)
  if (!target) throw new ContactPhoneResolutionError('CONTACT_NOT_FOUND', 'Contact not found')
  if (target.isArchived) throw new ContactPhoneResolutionError('CONTACT_NOT_ACTIVE', 'Contact is archived or merged')

  const rawOwners = await repository.findActivePhoneOwners(normalizedPhone)
  const rawOwnerIds = sortedUnique(rawOwners.map(owner => owner.id))
  const resolved = await Promise.all(rawOwners.map(owner => resolveCanonicalOwner(owner, repository)))
  const unsafeContactIds = sortedUnique(resolved.flatMap(result => result.kind === 'unsafe' ? result.contactIds : []))
  const canonicalOwnerIds = sortedUnique(resolved.flatMap(result => result.kind === 'canonical' ? [result.contactId] : []))

  let ownershipStatus: PhoneOwnershipStatus
  if (unsafeContactIds.length > 0 || canonicalOwnerIds.length > 1) {
    ownershipStatus = 'AMBIGUOUS'
  } else if (canonicalOwnerIds.length === 0) {
    ownershipStatus = 'FREE'
  } else if (canonicalOwnerIds[0] === contactId) {
    ownershipStatus = 'SAME_CONTACT'
  } else {
    ownershipStatus = 'OTHER_CONTACT'
  }

  const fingerprintIds = sortedUnique([...canonicalOwnerIds, ...unsafeContactIds])
  return {
    ownershipStatus,
    rawOwnerIds,
    canonicalOwnerIds,
    unsafeContactIds,
    fingerprint: `${ownershipStatus}:${fingerprintIds.join(',')}`,
  }
}

function tokenSecret(): string {
  const secret = process.env.PHONE_RESOLUTION_TOKEN_SECRET
    || process.env.NEXTAUTH_SECRET
    || process.env.AUTH_SECRET
    || process.env.DATABASE_URL
  if (!secret) throw new ContactPhoneResolutionError('INVALID_CONFIRMATION_TOKEN', 'Phone confirmation is not configured')
  return secret
}

function signToken(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url')
}

export function createPhoneConfirmationToken(
  payload: Omit<ConfirmationPayload, 'version' | 'expiresAt'>,
  options: { secret?: string; now?: number } = {},
): string {
  const value: ConfirmationPayload = {
    version: 1,
    ...payload,
    expiresAt: (options.now ?? Date.now()) + TOKEN_TTL_MS,
  }
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encoded}.${signToken(encoded, options.secret ?? tokenSecret())}`
}

export function verifyPhoneConfirmationToken(
  token: string,
  options: { secret?: string; now?: number } = {},
): ConfirmationPayload {
  const [encoded, providedSignature] = token.split('.')
  if (!encoded || !providedSignature) {
    throw new ContactPhoneResolutionError('INVALID_CONFIRMATION_TOKEN', 'Confirmation token is invalid')
  }
  const expectedSignature = signToken(encoded, options.secret ?? tokenSecret())
  const provided = Buffer.from(providedSignature)
  const expected = Buffer.from(expectedSignature)
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new ContactPhoneResolutionError('INVALID_CONFIRMATION_TOKEN', 'Confirmation token is invalid')
  }

  let payload: ConfirmationPayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ConfirmationPayload
  } catch {
    throw new ContactPhoneResolutionError('INVALID_CONFIRMATION_TOKEN', 'Confirmation token is invalid')
  }
  if (
    payload.version !== 1
    || !payload.contactId
    || !payload.normalizedPhone
    || !payload.fingerprint
    || payload.expiresAt < (options.now ?? Date.now())
  ) {
    throw new ContactPhoneResolutionError('INVALID_CONFIRMATION_TOKEN', 'Confirmation token expired or is invalid')
  }
  return payload
}

function ownershipRepository(db: PhoneResolutionDb): PhoneOwnershipRepository {
  return {
    async findContact(contactId) {
      return db.contact.findUnique({ where: { id: contactId }, select: { id: true, isArchived: true } })
    },
    async findActivePhoneOwners(normalizedPhone) {
      const rows = await db.contactPhone.findMany({
        where: { phone: normalizedPhone, isActive: true },
        select: { contact: { select: { id: true, isArchived: true } } },
      })
      return rows.map(row => row.contact)
    },
    async findMergeSurvivors(contactId) {
      return db.contactMerge.findMany({
        where: { mergedId: contactId, action: 'merge' },
        select: { survivor: { select: { id: true, isArchived: true } } },
      })
    },
  }
}

async function loadOwnerSummaries(contactIds: string[], normalizedPhone: string): Promise<PhoneOwnerSummary[]> {
  if (contactIds.length === 0) return []
  const contacts = await prisma.contact.findMany({
    where: { id: { in: contactIds } },
    select: {
      id: true,
      displayName: true,
      isArchived: true,
      phones: { where: { isActive: true }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], take: 1, select: { phone: true } },
      identities: { where: { isActive: true }, select: { channel: true } },
      mainDriver: { select: { id: true, fullName: true, lastExternalPark: true, park: { select: { parkName: true } } } },
      chats: { orderBy: { lastMessageAt: 'desc' }, take: 1, select: { id: true, lastMessageAt: true } },
      _count: { select: { driverProfiles: true } },
    },
  })

  return contacts.map(contact => ({
    id: contact.id,
    displayName: contact.displayName,
    phone: contact.phones[0]?.phone || normalizedPhone,
    channels: sortedUnique(contact.identities.map(identity => identity.channel)),
    mainDriverProfile: contact.mainDriver ? {
      id: contact.mainDriver.id,
      fullName: contact.mainDriver.fullName,
      parkName: contact.mainDriver.park?.parkName || contact.mainDriver.lastExternalPark || 'Парк не указан',
    } : null,
    driverProfileCount: contact._count.driverProfiles,
    lastContactAt: contact.chats[0]?.lastMessageAt?.toISOString() || null,
    chatId: contact.chats[0]?.id || null,
    isArchived: contact.isArchived,
  })).sort((left, right) => left.id.localeCompare(right.id))
}

function summarizeSuggestions(suggestions: SuggestedDriverProfile[]): PhoneSuggestionSummary[] {
  return suggestions.map(profile => ({
    id: profile.id,
    fullName: profile.fullName,
    parkName: profile.parkName,
    status: profile.status,
    conflictContactId: profile.conflictContactId,
    matchedSignals: profile.matchedSignals,
  }))
}

function logResolutionAudit(input: {
  operator: string
  contactId: string
  normalizedPhone: string
  ownershipStatus: PhoneOwnershipStatus
  ownerCount: number
  action: 'added' | 'same_contact' | 'blocked_existing_owner' | 'ambiguous' | 'merge_review_opened'
}) {
  console.info(JSON.stringify({ event: 'contact_phone_resolution', at: new Date().toISOString(), ...input }))
}

async function buildPreflight(
  contactId: string,
  normalizedPhone: string,
  evaluation: PhoneOwnershipEvaluation,
): Promise<ContactPhonePreflight> {
  const ownerIds = sortedUnique([...evaluation.canonicalOwnerIds, ...evaluation.unsafeContactIds])
  const ownerContacts = await loadOwnerSummaries(ownerIds, normalizedPhone)
  const suggestions = evaluation.ownershipStatus === 'FREE' || evaluation.ownershipStatus === 'SAME_CONTACT'
    ? await findSuggestedDriverProfilesByPhone(normalizedPhone, contactId)
    : []
  return {
    normalizedPhone,
    ownershipStatus: evaluation.ownershipStatus,
    resolutionStatus: evaluation.ownershipStatus === 'AMBIGUOUS'
      ? 'PHONE_OWNERSHIP_AMBIGUOUS'
      : evaluation.ownershipStatus,
    ownerContacts,
    driverProfileSuggestions: summarizeSuggestions(suggestions),
    searchedParks: PARK_PRIORITY,
    canAdd: evaluation.ownershipStatus === 'FREE',
    canReviewMerge: evaluation.ownershipStatus === 'OTHER_CONTACT',
    confirmationToken: createPhoneConfirmationToken({
      contactId,
      normalizedPhone,
      ownershipStatus: evaluation.ownershipStatus,
      fingerprint: evaluation.fingerprint,
    }),
  }
}

export async function preflightContactPhone(input: {
  contactId: string
  rawPhone: string
  operator: string
}): Promise<ContactPhonePreflight> {
  const normalizedPhone = normalizeRussianPhoneE164(input.rawPhone)
  if (!normalizedPhone) throw new ContactPhoneResolutionError('INVALID_PHONE', 'Введите российский номер из 10 цифр')

  const evaluation = await classifyContactPhoneOwnership(
    input.contactId,
    normalizedPhone,
    ownershipRepository(prisma as unknown as PhoneResolutionDb),
  )
  const action = evaluation.ownershipStatus === 'FREE'
    ? null
    : evaluation.ownershipStatus === 'SAME_CONTACT'
      ? 'same_contact' as const
      : evaluation.ownershipStatus === 'OTHER_CONTACT'
        ? 'blocked_existing_owner' as const
        : 'ambiguous' as const
  if (action) {
    logResolutionAudit({
      operator: input.operator,
      contactId: input.contactId,
      normalizedPhone,
      ownershipStatus: evaluation.ownershipStatus,
      ownerCount: evaluation.canonicalOwnerIds.length + evaluation.unsafeContactIds.length,
      action,
    })
  }
  return buildPreflight(input.contactId, normalizedPhone, evaluation)
}

export async function confirmContactPhone(input: {
  contactId: string
  confirmationToken: string
  operator: string
}) {
  const token = verifyPhoneConfirmationToken(input.confirmationToken)
  if (token.contactId !== input.contactId) {
    throw new ContactPhoneResolutionError('INVALID_CONFIRMATION_TOKEN', 'Confirmation token belongs to another Contact')
  }

  const transactionResult = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contact-phone:${token.normalizedPhone}`}))`
    const evaluation = await classifyContactPhoneOwnership(
      input.contactId,
      token.normalizedPhone,
      ownershipRepository(tx),
    )

    if (evaluation.ownershipStatus === 'SAME_CONTACT') {
      return { action: 'same_contact' as const, evaluation }
    }
    if (evaluation.ownershipStatus !== 'FREE') {
      return { action: 'blocked' as const, evaluation }
    }
    if (token.ownershipStatus !== 'FREE' || token.fingerprint !== evaluation.fingerprint) {
      return { action: 'stale' as const, evaluation }
    }

    const existingOwn = await tx.contactPhone.findUnique({
      where: { contactId_phone: { contactId: input.contactId, phone: token.normalizedPhone } },
    })
    const activePhoneCount = await tx.contactPhone.count({ where: { contactId: input.contactId, isActive: true } })
    const isPrimary = activePhoneCount === 0
    const phone = existingOwn
      ? await tx.contactPhone.update({
          where: { id: existingOwn.id },
          data: { isActive: true, isPrimary: existingOwn.isPrimary || isPrimary, source: 'manual' },
        })
      : await tx.contactPhone.create({
          data: { contactId: input.contactId, phone: token.normalizedPhone, isPrimary, source: 'manual' },
        })

    if (isPrimary) {
      await tx.contact.update({ where: { id: input.contactId }, data: { primaryPhoneId: phone.id } })
    }
    await tx.contactDriverProfileAudit.create({
      data: {
        contactId: input.contactId,
        action: 'contact_phone_manual_added',
        selectedBy: input.operator,
        reason: 'operator_confirmed_free_phone',
        metadata: { phone: token.normalizedPhone, preflight: token.ownershipStatus },
      },
    })
    return { action: 'added' as const, evaluation, phoneId: phone.id }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15000 })

  if (transactionResult.action === 'blocked' || transactionResult.action === 'stale') {
    return {
      ok: false as const,
      code: transactionResult.action === 'stale' ? 'PREFLIGHT_STALE' as const : 'PHONE_OWNERSHIP_CHANGED' as const,
      preflight: await buildPreflight(input.contactId, token.normalizedPhone, transactionResult.evaluation),
    }
  }

  const contactResolution = await ContactResolutionService.fromPrisma().resolve({
    channel: 'telegram',
    normalizedPhone: token.normalizedPhone,
    phoneEvidence: { source: 'manual_verified', trustedForAutomaticResolution: true },
    chatKind: 'private',
  })
  const suggestions = await findSuggestedDriverProfilesByPhone(token.normalizedPhone, input.contactId)
  logResolutionAudit({
    operator: input.operator,
    contactId: input.contactId,
    normalizedPhone: token.normalizedPhone,
    ownershipStatus: 'SAME_CONTACT',
    ownerCount: 1,
    action: transactionResult.action,
  })

  return {
    ok: true as const,
    action: transactionResult.action,
    normalizedPhone: token.normalizedPhone,
    phoneId: transactionResult.action === 'added' ? transactionResult.phoneId : null,
    contactResolutionStatus: contactResolution.status,
    driverProfileSuggestions: summarizeSuggestions(suggestions),
    searchedParks: PARK_PRIORITY,
  }
}

export function auditMergeReviewOpened(input: {
  contactId: string
  confirmationToken: string
  operator: string
}) {
  const token = verifyPhoneConfirmationToken(input.confirmationToken)
  if (token.contactId !== input.contactId || token.ownershipStatus !== 'OTHER_CONTACT') {
    throw new ContactPhoneResolutionError('INVALID_CONFIRMATION_TOKEN', 'Merge review token is invalid')
  }
  logResolutionAudit({
    operator: input.operator,
    contactId: input.contactId,
    normalizedPhone: token.normalizedPhone,
    ownershipStatus: 'OTHER_CONTACT',
    ownerCount: 1,
    action: 'merge_review_opened',
  })
  return { ok: true as const }
}
