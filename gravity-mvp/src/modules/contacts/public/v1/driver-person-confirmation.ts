import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'
import {
  CONFIRM_DRIVER_PERSON_COMMAND_V1,
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
export type { ConfirmDriverPersonCommandV1, DriverClusterProfileEvidenceV1, ReconcileDriverClusterCommandV1 }

export type ConfirmDriverPersonResultV1 = {
  status: 'confirmed' | 'already_confirmed' | 'contradiction'
  confirmationId: string
  contactId: string
  profileClusterKey: string
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
  return { ...value, identityConflicts: [...current, conflict].slice(-100) }
}

export async function confirmDriverPersonV1(
  command: ConfirmDriverPersonCommandV1,
): Promise<ConfirmDriverPersonResultV1> {
  if (command.contract !== CONFIRM_DRIVER_PERSON_COMMAND_V1) throw new TypeError('unsupported contract')
  const contactId = requireText(command.contactId, 'contactId')
  const clusterKey = requireText(command.profileClusterKey, 'profileClusterKey')
  const actor = requireText(command.confirmedBy, 'confirmedBy')
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
    const other = await transaction.contact.findFirst({
      where: {
        id: { not: contactId },
        isArchived: false,
        customFields: { path: ['confirmedDriverClusterKeys'], array_contains: [clusterKey] },
      },
      select: { id: true },
    })
    const now = new Date().toISOString()
    const existing = current.find(item => item.profileClusterKey === clusterKey && item.status === 'confirmed')
    const confirmationId = existing?.id ?? randomUUID()
    const record: StoredConfirmation = {
      id: confirmationId,
      profileClusterKey: clusterKey,
      representativeDriverId: command.representativeDriverId,
      status: other ? 'contradicted' : 'confirmed',
      confirmedBy: actor,
      confirmationBasis: command.confirmationBasis,
      searchInput: command.searchInput,
      evidenceRoot,
      evidenceSnapshot: command.evidenceSnapshot,
      confirmedAt: existing?.confirmedAt ?? now,
      lastReconciledAt: now,
    }
    const nextConfirmations = [...current.filter(item => item.id !== confirmationId), record].slice(-50)
    let nextFields: Prisma.InputJsonObject = {
      ...contactFields,
      driverConfirmations: nextConfirmations as unknown as Prisma.InputJsonArray,
      confirmedDriverClusterKeys: other
        ? (Array.isArray(contactFields.confirmedDriverClusterKeys) ? contactFields.confirmedDriverClusterKeys : [])
        : [...new Set([
            ...(Array.isArray(contactFields.confirmedDriverClusterKeys)
              ? contactFields.confirmedDriverClusterKeys.filter((item): item is string => typeof item === 'string')
              : []),
            clusterKey,
          ])],
    }
    if (other) {
      nextFields = appendConflict(nextFields, {
        id: randomUUID(),
        otherContactId: other.id,
        conflictType: 'confirmed_driver_cluster_contradiction',
        source: 'operator-confirmation',
        evidenceRoot,
        details: { profileClusterKey: clusterKey, representativeDriverId: command.representativeDriverId },
        detectedAt: now,
        status: 'open',
      })
    }
    await transaction.contact.update({
      where: { id: contactId },
      data: {
        customFields: nextFields,
        ...(!other ? {
          mainDriverId: command.representativeDriverId,
          mainDriverSelection: 'manual',
          mainDriverSelectedBy: actor,
          mainDriverSelectedAt: new Date(now),
        } : {}),
      },
    })
    return {
      status: other ? 'contradiction' : existing ? 'already_confirmed' : 'confirmed',
      confirmationId,
      contactId,
      profileClusterKey: clusterKey,
    }
  })
}

export async function getConfirmedContactForDriverClusterV1(
  profileClusterKey: string,
): Promise<{ contactId: string; confirmationId: string; evidenceRoot: string } | null> {
  const contact = await prisma.contact.findFirst({
    where: {
      isArchived: false,
      customFields: { path: ['confirmedDriverClusterKeys'], array_contains: [profileClusterKey] },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, customFields: true },
  })
  const confirmation = contact
    ? confirmations(fields(contact.customFields)).find(item => (
        item.profileClusterKey === profileClusterKey && item.status === 'confirmed'
      ))
    : null
  return contact && confirmation
    ? { contactId: contact.id, confirmationId: confirmation.id, evidenceRoot: confirmation.evidenceRoot }
    : null
}

export type ReconcileDriverClusterResultV1 =
  | { status: 'link'; contactId: string; basis: 'operator_confirmation' | 'unique_phone' }
  | { status: 'unlinked' }
  | { status: 'conflict'; contactIds: string[] }

export async function reconcileDriverClusterContactV1(
  command: ReconcileDriverClusterCommandV1,
): Promise<ReconcileDriverClusterResultV1> {
  if (command.contract !== RECONCILE_DRIVER_CLUSTER_COMMAND_V1) throw new TypeError('unsupported contract')
  const confirmed = await getConfirmedContactForDriverClusterV1(command.profileClusterKey)
  if (confirmed) return { status: 'link', contactId: confirmed.contactId, basis: 'operator_confirmation' }

  const normalizedPhones = [...new Set(command.profiles.flatMap(profile => profile.phones))].sort()
  if (normalizedPhones.length === 0) return { status: 'unlinked' }
  const owners = await prisma.contactPhone.findMany({
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
  const eligibleOwners = owners.filter(owner => {
    const evidence = phoneEvidenceState(owner.contact.customFields, owner.id, owner)
    return evidence.lifecycle === 'current'
      && ['provider_bound', 'manually_verified'].includes(evidence.trust)
      && evidence.freshness === 'fresh'
      && evidence.resolutionState === 'unique'
  })
  const contactIds = [...new Set(eligibleOwners.map(owner => owner.contactId))].sort()
  if (contactIds.length === 0) return { status: 'unlinked' }
  if (contactIds.length > 1) {
    await persistDriverClusterContradictionV1({
      profileClusterKey: command.profileClusterKey,
      contactIds,
      driverIds: command.profiles.map(profile => profile.driverId),
      evidenceRoot: command.profileClusterKey,
    })
    return { status: 'conflict', contactIds }
  }
  return { status: 'link', contactId: contactIds[0], basis: 'unique_phone' }
}

export async function persistDriverClusterContradictionV1(input: {
  profileClusterKey: string
  contactIds: string[]
  driverIds: string[]
  evidenceRoot: string
}): Promise<void> {
  const contactIds = [...new Set(input.contactIds)].sort()
  await runContactOwnershipTransaction(async transaction => {
    await lockContactOwnershipRows(transaction, { contactIds })
    for (const contactId of contactIds) {
      const contact = await transaction.contact.findUnique({ where: { id: contactId }, select: { customFields: true } })
      const contactFields = fields(contact?.customFields ?? null)
      await transaction.contact.update({
        where: { id: contactId },
        data: {
          customFields: appendConflict(contactFields, {
            id: randomUUID(),
            otherContactId: contactIds.find(candidate => candidate !== contactId) ?? null,
            conflictType: 'fleet_authoritative_person_contradiction',
            source: 'fleet-reconciliation',
            evidenceRoot: input.evidenceRoot,
            details: { profileClusterKey: input.profileClusterKey, driverIds: input.driverIds, contactIds },
            detectedAt: new Date().toISOString(),
            status: 'open',
          }),
        },
      })
    }
  })
}
