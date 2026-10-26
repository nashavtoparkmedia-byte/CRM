// The only database client of the contact communication policy foundation.
//
// Three bindings over Prisma, all Contacts-owned and all internal: the store
// that reads and writes ContactCommunicationPolicy and
// ContactCommunicationPolicyEvent (the mutation, the merge adapter and the
// recovery adapter all go through it, so there is exactly one place that
// persists the two models); the permission read port, which resolves lineage
// and reads the policy inside one REPEATABLE READ snapshot; and the mutation
// port, which runs the handler inside the Contacts ownership transaction with
// the Contact's ownership rows locked.
//
// Every read selects an explicit, non-sensitive column list. The policy row is
// created at version 1 and otherwise advanced by a compare-and-set update that
// must touch exactly one row; it is never upserted and never deleted here.
// Contact.customFields is neither read nor written for policy purposes.

import { randomUUID } from 'node:crypto'

import { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'

import {
  CONTACT_COMMUNICATION_RECOVERY_EVENT_BOUND_V1,
  type ContactCommunicationPolicyEventInputV1,
  type ContactCommunicationPolicyLockedScopeV1,
  type ContactCommunicationPolicyMutationEventV1,
  type ContactCommunicationPolicyMutationPortV1,
  type ContactCommunicationPolicyReadPortV1,
  type ContactCommunicationPolicyRecoveryEventV1,
  type ContactCommunicationPolicySnapshotV1,
  type ContactCommunicationPermissionStateV1,
} from '../public/v1/contact-communication-policy'
import { createResolveContactLineageHandlerV1 } from '../public/v1/contact-lineage-handler'
import {
  ContactOwnershipInvariantError,
  lockContactOwnershipRows,
  runContactOwnershipTransaction,
} from './contact-ownership-coordinator'
import { makePrismaContactLineagePortV1 } from './prisma-contact-lineage-port'

export type ContactCommunicationPolicyClientV1 = Pick<
  Prisma.TransactionClient,
  'contact' | 'contactMerge' | 'contactCommunicationPolicy' | 'contactCommunicationPolicyEvent'
>

const POLICY_SELECT = {
  contactId: true,
  denyAll: true,
  denyMessage: true,
  denyVoice: true,
  version: true,
} as const

type PolicyRow = {
  denyAll: boolean
  denyMessage: boolean
  denyVoice: boolean
  version: number
}

function snapshotOf(row: PolicyRow | null): ContactCommunicationPolicySnapshotV1 | null {
  return row === null
    ? null
    : { denyAll: row.denyAll, denyMessage: row.denyMessage, denyVoice: row.denyVoice, version: row.version }
}

export type ContactCommunicationPolicyStoreV1 = Pick<
  ContactCommunicationPolicyLockedScopeV1,
  'findMutationEvent' | 'readPolicy' | 'writePolicy' | 'appendEvent'
> & {
  /** Events of one Contact after a version, ascending; fails closed past the recovery bound. */
  listEventsAfter(contactId: string, version: number): Promise<ContactCommunicationPolicyRecoveryEventV1[]>
}

/** The one writer of the two policy models, bound to an admitted transaction client. */
export function makePrismaContactCommunicationPolicyStoreV1(tx: ContactCommunicationPolicyClientV1): ContactCommunicationPolicyStoreV1 {
  return {
    async readPolicy(contactId) {
      const row = await tx.contactCommunicationPolicy.findUnique({
        where: { contactId },
        select: POLICY_SELECT,
      })
      return snapshotOf(row)
    },

    async findMutationEvent(requestId): Promise<ContactCommunicationPolicyMutationEventV1 | null> {
      const event = await tx.contactCommunicationPolicyEvent.findUnique({
        where: { mutationRequestId: requestId },
        select: {
          contactId: true,
          requestDigest: true,
          version: true,
          afterDenyAll: true,
          afterDenyMessage: true,
          afterDenyVoice: true,
        },
      })
      if (!event) return null
      return {
        contactId: event.contactId,
        requestDigest: event.requestDigest ?? '',
        version: event.version,
        after: { denyAll: event.afterDenyAll, denyMessage: event.afterDenyMessage, denyVoice: event.afterDenyVoice },
      }
    },

    async listEventsAfter(contactId, version) {
      const events = await tx.contactCommunicationPolicyEvent.findMany({
        where: { contactId, version: { gt: version } },
        orderBy: { version: 'asc' },
        select: { cause: true, version: true, mergeId: true },
        take: CONTACT_COMMUNICATION_RECOVERY_EVENT_BOUND_V1,
      })
      if (events.length >= CONTACT_COMMUNICATION_RECOVERY_EVENT_BOUND_V1) {
        throw new ContactOwnershipInvariantError(
          `Contact ${contactId} communication policy event chain exceeds the recovery bound`,
        )
      }
      return events.map(event => ({
        cause: event.cause as ContactCommunicationPolicyRecoveryEventV1['cause'],
        version: event.version,
        mergeId: event.mergeId,
      }))
    },

    async writePolicy(input) {
      if (input.expectedVersion === 0) {
        if (input.version !== 1) {
          throw new ContactOwnershipInvariantError('Contact communication policy must start at version 1')
        }
        await tx.contactCommunicationPolicy.create({
          data: {
            contactId: input.contactId,
            denyAll: input.restriction.denyAll,
            denyMessage: input.restriction.denyMessage,
            denyVoice: input.restriction.denyVoice,
            version: 1,
            updatedBy: input.actor,
          },
        })
        return
      }
      const updated = await tx.contactCommunicationPolicy.updateMany({
        where: { contactId: input.contactId, version: input.expectedVersion },
        data: {
          denyAll: input.restriction.denyAll,
          denyMessage: input.restriction.denyMessage,
          denyVoice: input.restriction.denyVoice,
          version: input.version,
          updatedBy: input.actor,
        },
      })
      if (updated.count !== 1) {
        throw new ContactOwnershipInvariantError(
          `Contact ${input.contactId} communication policy version ${input.expectedVersion} is no longer current`,
        )
      }
    },

    async appendEvent(input: ContactCommunicationPolicyEventInputV1) {
      await tx.contactCommunicationPolicyEvent.create({
        data: {
          eventId: randomUUID(),
          contactId: input.contactId,
          cause: input.cause,
          version: input.version,
          previousVersion: input.previousVersion,
          beforeDenyAll: input.before?.denyAll ?? null,
          beforeDenyMessage: input.before?.denyMessage ?? null,
          beforeDenyVoice: input.before?.denyVoice ?? null,
          afterDenyAll: input.after.denyAll,
          afterDenyMessage: input.after.denyMessage,
          afterDenyVoice: input.after.denyVoice,
          actor: input.actor,
          reason: input.reason,
          mutationRequestId: input.mutationRequestId,
          requestDigest: input.requestDigest,
          mergeId: input.mergeId,
          sourceContactId: input.sourceContactId,
        },
      })
    },
  }
}

/**
 * The permission read: one REPEATABLE READ snapshot covers the lineage walk
 * (the existing lineage handler, bound to the same client) and the canonical
 * Contact's archive flag and policy row, so a merge or recovery committing in
 * between cannot be observed half-applied.
 */
export function makePrismaContactCommunicationPolicyReadPortV1(
  client: Pick<typeof prisma, '$transaction'>,
): ContactCommunicationPolicyReadPortV1 {
  return {
    async readPermissionState(requestedContactId): Promise<ContactCommunicationPermissionStateV1> {
      return client.$transaction(async tx => {
        const resolveLineage = createResolveContactLineageHandlerV1(makePrismaContactLineagePortV1(tx))
        const lineage = await resolveLineage(requestedContactId)
        if (lineage === null) return { kind: 'unknown' as const }
        const contact = await tx.contact.findUnique({
          where: { id: lineage.canonicalContactId },
          select: { id: true, isArchived: true },
        })
        if (contact === null) return { kind: 'unknown' as const }
        const policy = await makePrismaContactCommunicationPolicyStoreV1(tx).readPolicy(contact.id)
        return { kind: 'found' as const, canonicalContactId: contact.id, isArchived: contact.isArchived, policy }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
    },
  }
}

export const legacyPrismaContactCommunicationPolicyReadPortV1 = makePrismaContactCommunicationPolicyReadPortV1(prisma)

/**
 * The mutation runs under CNT1 with the Contact's ownership rows locked, which
 * is the same admission every Contact merge and merge recovery takes, so a
 * policy write can never race a merge on a stale Contact snapshot.
 */
export const legacyPrismaContactCommunicationPolicyMutationPortV1: ContactCommunicationPolicyMutationPortV1 = {
  runLocked(contactId, work) {
    return runContactOwnershipTransaction(async tx => {
      await lockContactOwnershipRows(tx, { contactIds: [contactId] })
      const store = makePrismaContactCommunicationPolicyStoreV1(tx)
      const scope: ContactCommunicationPolicyLockedScopeV1 = {
        resolveLineage: createResolveContactLineageHandlerV1(makePrismaContactLineagePortV1(tx)),
        async readContact(id) {
          const contact = await tx.contact.findUnique({ where: { id }, select: { id: true, isArchived: true } })
          return contact === null ? null : { isArchived: contact.isArchived }
        },
        findMutationEvent: store.findMutationEvent,
        readPolicy: store.readPolicy,
        writePolicy: store.writePolicy,
        appendEvent: store.appendEvent,
      }
      return work(scope)
    })
  },
}
