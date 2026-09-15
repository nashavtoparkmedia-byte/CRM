import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'
import {
  CONFIRM_DRIVER_PERSON_COMMAND_V1,
  parseConfirmDriverPersonCommandV1,
  parseReconcileDriverClusterCommandV1,
  RECONCILE_DRIVER_CLUSTER_COMMAND_V1,
  type ConfirmDriverPersonCommandV1,
  type DriverClusterProfileEvidenceV1,
  type ReconcileDriverClusterCommandV1,
} from '@/contracts/contacts/v1'
import {
  lockContactOwnershipRows,
  runContactOwnershipTransaction,
} from '../../internal/contact-ownership-coordinator'
import { phoneEvidenceState } from './contact-evidence-state'

export { CONFIRM_DRIVER_PERSON_COMMAND_V1, RECONCILE_DRIVER_CLUSTER_COMMAND_V1 }
export type {
  ConfirmDriverPersonCommandV1,
  DriverClusterProfileEvidenceV1,
  ReconcileDriverClusterCommandV1,
}

export type ConfirmDriverPersonResultV1 = {
  status: 'confirmed' | 'already_confirmed' | 'needs_reconciliation' | 'contradiction'
  confirmationId: string
  contactId: string
  profileClusterKey: string
  mergeCandidateContactId?: string
  conflictingContactIds?: string[]
}

type StoredConfirmation = {
  id: string
  profileClusterKey: string
  representativeDriverId: string
  status: 'confirmed' | 'contradicted' | 'revoked' | 'needs_reconciliation'
  confirmedBy: string
  confirmationBasis: string
  searchInput: string
  evidenceRoot: string
  evidenceSnapshot: unknown
  confirmedAt: string
  lastReconciledAt: string | null
  reconciliationContactId?: string | null
}

function requireText(value: string, field: string): string {
  const result = value.trim()
  if (!result) throw new TypeError(`${field} is required`)
  return result
}

function fields(value: Prisma.JsonValue | null): Prisma.JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Prisma.JsonObject : {}
}

function confirmations(value: Prisma.JsonObject): StoredConfirmation[] {
  return Array.isArray(value.driverConfirmations)
    ? value.driverConfirmations.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as StoredConfirmation[]
    : []
}

function appendConflict(value: Prisma.InputJsonObject, conflict: Prisma.InputJsonObject): Prisma.InputJsonObject {
  const current = Array.isArray(value.identityConflicts) ? value.identityConflicts : []
  const duplicate = current.some(item => {
    const candidate = fields(item as Prisma.JsonValue)
    return candidate.status === 'open'
      && candidate.conflictType === conflict.conflictType
      && candidate.otherContactId === conflict.otherContactId
      && candidate.evidenceRoot === conflict.evidenceRoot
  })
  if (duplicate) return value
  return { ...value, identityConflicts: [...current, conflict].slice(-100) }
}

function activeConfirmationKeys(items: StoredConfirmation[]): string[] {
  return [...new Set(items
    .filter(item => item.status === 'confirmed' || item.status === 'needs_reconciliation')
    .map(item => item.profileClusterKey))].sort()
}

function hasActiveConfirmationForCluster(
  items: StoredConfirmation[],
  profileClusterKey: string,
): boolean {
  return items.some(item => (
    item.profileClusterKey === profileClusterKey
    && (item.status === 'confirmed' || item.status === 'needs_reconciliation')
  ))
}

export async function confirmDriverPersonV1(
  command: ConfirmDriverPersonCommandV1 | unknown,
): Promise<ConfirmDriverPersonResultV1> {
  const parsed = parseConfirmDriverPersonCommandV1(command)
  const contactId = requireText(parsed.contactId, 'contactId')
  const clusterKey = requireText(parsed.profileClusterKey, 'profileClusterKey')
  const actor = requireText(parsed.confirmedBy, 'confirmedBy')
  const evidenceRoot = `operator-confirmation:${contactId}:${clusterKey}`

  return runContactOwnershipTransaction(async transaction => {
    await lockContactOwnershipRows(transaction, { contactIds: [contactId] })
    const contact = await transaction.contact.findUnique({
      where: { id: contactId },
      select: { id: true, isArchived: true, customFields: true },
    })
    if (!contact || contact.isArchived) throw new Error('CONTACT_NOT_ELIGIBLE')
    const contactFields = fields(contact.customFields)
    const current = confirmations(contactFields)
    const now = new Date().toISOString()
    const existing = current.find(item => (
      item.profileClusterKey === clusterKey
      && (item.status === 'confirmed' || item.status === 'needs_reconciliation')
    ))
    const conflictingLocalConfirmations = current.filter(item => (
      item.profileClusterKey !== clusterKey
      && (item.status === 'confirmed' || item.status === 'needs_reconciliation')
    ))
    if (conflictingLocalConfirmations.length > 0) {
      const existingProfileClusterKeys = [...new Set(
        conflictingLocalConfirmations.map(item => item.profileClusterKey),
      )].sort()
      const preservedConfirmationId = existing?.id ?? conflictingLocalConfirmations[0].id
      const nextFields = appendConflict({
        ...contactFields,
        driverConfirmations: current as unknown as Prisma.InputJsonArray,
        confirmedDriverClusterKeys: activeConfirmationKeys(current),
      }, {
        id: randomUUID(),
        otherContactId: null,
        conflictType: 'confirmed_driver_cluster_contradiction',
        source: 'operator-confirmation',
        evidenceRoot,
        details: {
          requestedProfileClusterKey: clusterKey,
          representativeDriverId: parsed.representativeDriverId,
          existingProfileClusterKeys,
          existingRepresentativeDriverIds: [...new Set(
            conflictingLocalConfirmations.map(item => item.representativeDriverId),
          )].sort(),
        },
        detectedAt: now,
        status: 'open',
      })
      await transaction.contact.update({
        where: { id: contactId },
        data: { customFields: nextFields },
      })
      return {
        status: 'contradiction',
        confirmationId: preservedConfirmationId,
        contactId,
        profileClusterKey: clusterKey,
        conflictingContactIds: [contactId],
      }
    }
    const possibleOtherOwners = await transaction.contact.findMany({
      where: {
        id: { not: contactId },
        isArchived: false,
        customFields: { path: ['confirmedDriverClusterKeys'], array_contains: [clusterKey] },
      },
      orderBy: { id: 'asc' },
      select: { id: true, customFields: true },
    })
    const otherClaimantIds = possibleOtherOwners
      .filter(candidate => hasActiveConfirmationForCluster(
        confirmations(fields(candidate.customFields)),
        clusterKey,
      ))
      .map(candidate => candidate.id)
    const confirmationId = existing?.id ?? randomUUID()
    const hasSingleOtherClaimant = otherClaimantIds.length === 1
    const hasContradiction = otherClaimantIds.length > 1
    const preserveExistingConfirmation = existing?.status === 'confirmed'
      && otherClaimantIds.length > 0
    const preserveConfirmedAnchor = existing?.status === 'confirmed'
      && hasSingleOtherClaimant
      && possibleOtherOwners
        .filter(candidate => otherClaimantIds.includes(candidate.id))
        .every(candidate => confirmations(fields(candidate.customFields)).some(item => (
          item.profileClusterKey === clusterKey
          && item.status === 'needs_reconciliation'
          && item.reconciliationContactId === contactId
        )))
    // A newly discovered contradiction is separate state from the operator's
    // established confirmation. Keep the confirmed anchor intact until an
    // explicit reconciliation decides its fate; replacing it with a pending
    // or contradicted record would silently undo the human decision.
    const record: StoredConfirmation = preserveExistingConfirmation
      ? { ...existing, lastReconciledAt: now }
      : {
          id: confirmationId,
          profileClusterKey: clusterKey,
          representativeDriverId: parsed.representativeDriverId,
          status: hasContradiction
            ? 'contradicted'
            : hasSingleOtherClaimant ? 'needs_reconciliation' : 'confirmed',
          confirmedBy: actor,
          confirmationBasis: parsed.confirmationBasis,
          searchInput: parsed.searchInput,
          evidenceRoot: existing?.evidenceRoot ?? evidenceRoot,
          evidenceSnapshot: parsed.evidenceSnapshot,
          confirmedAt: existing?.confirmedAt ?? now,
          lastReconciledAt: now,
          reconciliationContactId: hasSingleOtherClaimant
            ? otherClaimantIds[0]
            : null,
        }
    const nextConfirmations = [...current.filter(item => item.id !== confirmationId), record].slice(-50)
    let nextFields: Prisma.InputJsonObject = {
      ...contactFields,
      driverConfirmations: nextConfirmations as unknown as Prisma.InputJsonArray,
      confirmedDriverClusterKeys: activeConfirmationKeys(nextConfirmations),
    }
    if (hasContradiction) {
      nextFields = appendConflict(nextFields, {
        id: randomUUID(),
        otherContactId: otherClaimantIds[0] ?? null,
        conflictType: 'confirmed_driver_cluster_contradiction',
        source: 'operator-confirmation',
        evidenceRoot,
        details: {
          profileClusterKey: clusterKey,
          representativeDriverId: parsed.representativeDriverId,
          conflictingContactIds: otherClaimantIds,
        },
        detectedAt: now,
        status: 'open',
      })
    }
    await transaction.contact.update({
      where: { id: contactId },
      data: {
        customFields: nextFields,
        ...(otherClaimantIds.length === 0 ? {
          mainDriverId: parsed.representativeDriverId,
          mainDriverSelection: 'manual',
          mainDriverSelectedBy: actor,
          mainDriverSelectedAt: new Date(now),
        } : {}),
      },
    })
    return {
      status: hasContradiction
        ? 'contradiction'
        : hasSingleOtherClaimant && !preserveConfirmedAnchor
          ? 'needs_reconciliation'
          : existing ? 'already_confirmed' : 'confirmed',
      confirmationId,
      contactId,
      profileClusterKey: clusterKey,
      ...(hasSingleOtherClaimant && !preserveConfirmedAnchor
        ? { mergeCandidateContactId: otherClaimantIds[0] }
        : {}),
      ...(hasContradiction ? { conflictingContactIds: otherClaimantIds } : {}),
    }
  })
}

export async function getConfirmedContactForDriverClusterV1(
  profileClusterKey: string,
): Promise<{ contactId: string; confirmationId: string; evidenceRoot: string } | null> {
  const candidates = await prisma.contact.findMany({
    where: {
      isArchived: false,
      customFields: { path: ['confirmedDriverClusterKeys'], array_contains: [profileClusterKey] },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, customFields: true },
  })
  const confirmedOwners = candidates.flatMap(contact => {
    const records = confirmations(fields(contact.customFields))
      .filter(item => (
        item.profileClusterKey === profileClusterKey && item.status === 'confirmed'
      ))
      .sort((left, right) => (
        `${left.confirmedAt ?? ''}\0${left.id}`.localeCompare(`${right.confirmedAt ?? ''}\0${right.id}`)
      ))
    return records.length > 0 ? [{ contact, records }] : []
  })
  // Merge composition can legitimately retain more than one independent
  // confirmation record on the same survivor. Ambiguity is about Contacts,
  // not the number of preserved audit records.
  if (confirmedOwners.length !== 1) return null
  const [{ contact, records }] = confirmedOwners
  const [confirmation] = records
  return { contactId: contact.id, confirmationId: confirmation.id, evidenceRoot: confirmation.evidenceRoot }
}

/**
 * Contacts-owned authorization query for a Driver-facing side effect.
 *
 * `mainDriverId` on its own is only a projection. The exact Driver must also
 * retain a confirmed operator decision, and unresolved Driver-person
 * contradictions must be absent. The read is protected by CNT1 so callers do
 * not have to interpret Contacts' private JSON state themselves.
 */
export async function isContactConfirmedMainDriverV1(
  contactIdInput: string,
  driverIdInput: string,
): Promise<boolean> {
  const contactId = requireText(contactIdInput, 'contactId')
  const driverId = requireText(driverIdInput, 'driverId')

  return runContactOwnershipTransaction(async transaction => {
    await lockContactOwnershipRows(transaction, { contactIds: [contactId] })
    const contact = await transaction.contact.findUnique({
      where: { id: contactId },
      select: {
        id: true,
        isArchived: true,
        mainDriverId: true,
        customFields: true,
      },
    })
    if (!contact || contact.isArchived || contact.mainDriverId !== driverId) return false

    const contactFields = fields(contact.customFields)
    const current = confirmations(contactFields)
    const hasExactConfirmation = current.some(item => (
      item.status === 'confirmed' && item.representativeDriverId === driverId
    ))
    const hasUnresolvedConfirmation = current.some(item => (
      item.status === 'needs_reconciliation'
      || (item.status === 'confirmed' && item.representativeDriverId !== driverId)
    ))
    const identityConflicts = Array.isArray(contactFields.identityConflicts)
      ? contactFields.identityConflicts
      : []
    const hasOpenDriverContradiction = identityConflicts.some(item => {
      const conflict = fields(item as Prisma.JsonValue)
      return conflict.status === 'open'
        && (
          conflict.conflictType === 'confirmed_driver_cluster_contradiction'
          || conflict.conflictType === 'fleet_authoritative_person_contradiction'
        )
    })

    return hasExactConfirmation
      && !hasUnresolvedConfirmation
      && !hasOpenDriverContradiction
  })
}

export type ReconcileDriverClusterResultV1 =
  | { status: 'link'; contactId: string; basis: 'operator_confirmation' | 'unique_phone' }
  | { status: 'unlinked' }
  | { status: 'conflict'; contactIds: string[] }

type DriverClusterContactReadClientV1 = Pick<Prisma.TransactionClient, 'contact' | 'contactPhone'>

async function reconcileDriverClusterContactWithClientV1(
  client: DriverClusterContactReadClientV1,
  command: ReconcileDriverClusterCommandV1 | unknown,
): Promise<ReconcileDriverClusterResultV1> {
  const parsed = parseReconcileDriverClusterCommandV1(command)
  const confirmationOwners = await client.contact.findMany({
    where: {
      isArchived: false,
      customFields: {
        path: ['confirmedDriverClusterKeys'],
        array_contains: [parsed.profileClusterKey],
      },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, customFields: true },
  })
  const confirmedContactIds = [...new Set(confirmationOwners
    .filter(contact => confirmations(fields(contact.customFields)).some(item => (
      item.profileClusterKey === parsed.profileClusterKey && item.status === 'confirmed'
    )))
    .map(contact => contact.id))].sort()
  if (confirmedContactIds.length > 1) return { status: 'conflict', contactIds: confirmedContactIds }
  if (confirmedContactIds.length === 1) {
    return { status: 'link', contactId: confirmedContactIds[0], basis: 'operator_confirmation' }
  }

  const normalizedPhones = [...new Set(parsed.profiles
    .filter(profile => profile.sourceFreshness === 'fresh')
    .flatMap(profile => profile.phones))].sort()
  if (normalizedPhones.length === 0) return { status: 'unlinked' }
  const owners = await client.contactPhone.findMany({
    where: {
      phone: { in: normalizedPhones },
      isActive: true,
      contact: { isArchived: false },
    },
    select: {
      id: true,
      contactId: true,
      phone: true,
      isActive: true,
      verifiedAt: true,
      contact: { select: { customFields: true } },
    },
  })
  const eligibleContactIds = new Set<string>()
  const conflictingContactIds = new Set<string>()
  for (const phone of normalizedPhones) {
    const activeClaims = owners.filter(owner => owner.phone === phone)
    if (activeClaims.length === 0) continue

    const activeContactIds = [...new Set(activeClaims.map(owner => owner.contactId))].sort()
    if (activeContactIds.length > 1) {
      // An ineligible claim is still an active ownership claim. Ignoring it
      // would let a better-decorated row silently win the same phone.
      for (const contactId of activeContactIds) conflictingContactIds.add(contactId)
      continue
    }

    const everyClaimEligible = activeClaims.every(owner => {
      const evidence = phoneEvidenceState(owner.contact.customFields, owner.id, owner)
      return evidence.lifecycle === 'current'
        && ['provider_bound', 'manually_verified'].includes(evidence.trust)
        && evidence.freshness === 'fresh'
        && evidence.resolutionState === 'unique'
    })
    if (everyClaimEligible) eligibleContactIds.add(activeContactIds[0])
  }

  const contactIds = [...new Set([
    ...eligibleContactIds,
    ...conflictingContactIds,
  ])].sort()
  if (conflictingContactIds.size > 0 || eligibleContactIds.size > 1) {
    return { status: 'conflict', contactIds }
  }
  if (eligibleContactIds.size === 0) return { status: 'unlinked' }
  return { status: 'link', contactId: contactIds[0], basis: 'unique_phone' }
}

export async function reconcileDriverClusterContactV1(
  command: ReconcileDriverClusterCommandV1 | unknown,
): Promise<ReconcileDriverClusterResultV1> {
  const parsed = parseReconcileDriverClusterCommandV1(command)
  const result = await reconcileDriverClusterContactWithClientV1(prisma, parsed)
  if (result.status === 'conflict') {
    await persistDriverClusterContradictionV1({
      profileClusterKey: parsed.profileClusterKey,
      contactIds: result.contactIds,
      driverIds: parsed.profiles.map(profile => profile.driverId),
      evidenceRoot: parsed.profileClusterKey,
    })
  }
  return result
}

export type DriverClusterContactOwnershipCapabilityV1 = {
  reconcile(command: ReconcileDriverClusterCommandV1): Promise<ReconcileDriverClusterResultV1>
  persistContradiction(input: {
    profileClusterKey: string
    contactIds: string[]
    driverIds: string[]
    evidenceRoot: string
  }): Promise<void>
}

export const DRIVER_CLUSTER_CONTACT_OWNERSHIP_TIMEOUT_MS_V1 = 30_000
const MAX_CANONICAL_CONTACT_REDIRECT_DEPTH = 16

async function resolveCanonicalContradictionContactsV1(
  transaction: Prisma.TransactionClient,
  requestedContactIds: string[],
): Promise<Array<{ id: string; customFields: Prisma.JsonValue | null }>> {
  const canonical = new Map<string, { id: string; customFields: Prisma.JsonValue | null }>()
  for (const requestedContactId of requestedContactIds) {
    let contactId = requestedContactId
    const visited = new Set<string>()
    for (let depth = 0; depth < MAX_CANONICAL_CONTACT_REDIRECT_DEPTH; depth += 1) {
      if (visited.has(contactId)) throw new Error('DRIVER_CLUSTER_CONTACT_REDIRECT_CYCLE')
      visited.add(contactId)
      const contact = await transaction.contact.findUnique({
        where: { id: contactId },
        select: { id: true, isArchived: true, customFields: true },
      })
      if (!contact) throw new Error('DRIVER_CLUSTER_CONTACT_NOT_FOUND')
      const redirect = fields(contact.customFields).mergedIntoContactId
      if (!contact.isArchived) {
        if (typeof redirect === 'string' && redirect.trim()) {
          throw new Error('DRIVER_CLUSTER_ACTIVE_CONTACT_REDIRECT')
        }
        canonical.set(contact.id, { id: contact.id, customFields: contact.customFields })
        break
      }
      if (typeof redirect !== 'string' || !redirect.trim() || redirect === contact.id) {
        throw new Error('DRIVER_CLUSTER_CONTACT_ARCHIVED')
      }
      contactId = redirect
      if (depth === MAX_CANONICAL_CONTACT_REDIRECT_DEPTH - 1) {
        throw new Error('DRIVER_CLUSTER_CONTACT_REDIRECT_DEPTH')
      }
    }
  }
  return [...canonical.values()].sort((left, right) => left.id.localeCompare(right.id))
}

async function persistDriverClusterContradictionWithClientV1(
  transaction: Prisma.TransactionClient,
  input: {
    profileClusterKey: string
    contactIds: string[]
    driverIds: string[]
    evidenceRoot: string
  },
): Promise<void> {
  const requestedContactIds = [...new Set(input.contactIds)].sort()
  await lockContactOwnershipRows(transaction, { contactIds: requestedContactIds })
  const contacts = await resolveCanonicalContradictionContactsV1(transaction, requestedContactIds)
  const contactIds = contacts.map(contact => contact.id)
  const detectedAt = new Date().toISOString()
  for (const contact of contacts) {
    const contactFields = fields(contact.customFields)
    await transaction.contact.update({
      where: { id: contact.id },
      data: {
        customFields: appendConflict(contactFields, {
          id: randomUUID(),
          otherContactId: contactIds.find(candidate => candidate !== contact.id) ?? null,
          conflictType: 'fleet_authoritative_person_contradiction',
          source: 'fleet-reconciliation',
          evidenceRoot: input.evidenceRoot,
          details: {
            profileClusterKey: input.profileClusterKey,
            driverIds: input.driverIds,
            contactIds,
          },
          detectedAt,
          status: 'open',
        }),
      },
    })
  }
}

/** Holds CNT1 while a Fleet owner re-reads and mutates one Driver cluster. */
export async function runDriverClusterContactOwnershipV1<T>(
  work: (capability: DriverClusterContactOwnershipCapabilityV1) => Promise<T>,
): Promise<T> {
  return runContactOwnershipTransaction(async transaction => work({
    reconcile: command => reconcileDriverClusterContactWithClientV1(transaction, command),
    persistContradiction: input => persistDriverClusterContradictionWithClientV1(transaction, input),
  }), {
    // The nested Fleet unit has maxWait 2s + timeout 15s. Keep CNT1 for the
    // full inner budget plus a 13s cancellation/rollback margin.
    transactionTimeoutMs: DRIVER_CLUSTER_CONTACT_OWNERSHIP_TIMEOUT_MS_V1,
    maxWaitMs: 2_000,
  })
}

export async function persistDriverClusterContradictionV1(input: {
  profileClusterKey: string
  contactIds: string[]
  driverIds: string[]
  evidenceRoot: string
}): Promise<void> {
  await runContactOwnershipTransaction(async transaction => {
    await persistDriverClusterContradictionWithClientV1(transaction, input)
  })
}
