import { Prisma, type ChatChannel } from '@prisma/client'

import { prisma } from '@/lib/prisma'
import {
  CONTACT_OWNERSHIP_ADVISORY_CLASS_ID_V1,
  CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID_V1,
} from '../public/v1/contact-ownership-lock-contract'

/**
 * PostgreSQL advisory-lock namespace registry (two-int32 key space).
 *
 * classid 0x594f4b4f = ASCII "YOKO"
 * objid   0x434e5431 = ASCII "CNT1" (Contacts ownership coordinator v1)
 *
 * The readable, two-part key deliberately avoids an anonymous bigint in the
 * cluster-wide advisory namespace. New coordinators must reserve another
 * four-byte objid here instead of reusing CNT1.
 */
export const CONTACT_OWNERSHIP_ADVISORY_CLASS_ID = CONTACT_OWNERSHIP_ADVISORY_CLASS_ID_V1
export const CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID = CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID_V1

const DEFAULT_LOCK_TIMEOUT_MS = 2_000
const DEFAULT_TRANSACTION_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ROWS_PER_RELATION = 512
const MAX_CONTACT_MERGE_DEPTH = 16

const admittedTransactions = new WeakSet<object>()

export class ContactOwnershipBusyError extends Error {
  readonly code = 'CONTACT_OWNERSHIP_BUSY'

  constructor(message = 'Contact ownership coordinator is busy') {
    super(message)
    this.name = 'ContactOwnershipBusyError'
  }
}

export class ContactOwnershipInvariantError extends Error {
  readonly code = 'CONTACT_OWNERSHIP_INVARIANT'

  constructor(message: string) {
    super(message)
    this.name = 'ContactOwnershipInvariantError'
  }
}

export type ContactOwnershipTransaction = Prisma.TransactionClient

export type ContactOwnershipIdentitySelector = {
  channel: ChatChannel
  providerAccountId?: string
  externalId: string
}

export type ContactOwnershipLockSelector = {
  contactIds?: readonly string[]
  phoneIds?: readonly string[]
  normalizedPhones?: readonly string[]
  identityIds?: readonly string[]
  identities?: readonly ContactOwnershipIdentitySelector[]
  mergeIds?: readonly string[]
  yandexDriverIds?: readonly string[]
}

export type ContactOwnershipLockedScope = {
  contactIds: string[]
  phoneIds: string[]
  normalizedPhones: string[]
  identityIds: string[]
  mergeIds: string[]
}

type ContactOwnershipRunOptions = {
  lockTimeoutMs?: number
  transactionTimeoutMs?: number
  maxWaitMs?: number
  maxRowsPerRelation?: number
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`Contact ownership timeout/limit must be an integer between 1 and ${maximum}`)
  }
  return value
}

function boundedStrings(values: readonly string[] | undefined, field: string): string[] {
  if (!values) return []
  if (values.length > DEFAULT_MAX_ROWS_PER_RELATION) {
    throw new ContactOwnershipInvariantError(`${field} exceeds the bounded coordinator input`)
  }
  const result = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
      throw new TypeError(`${field} must contain bounded non-empty strings`)
    }
    result.add(value)
  }
  return [...result].sort()
}

function isLockTimeout(error: unknown): boolean {
  const candidate = error as {
    code?: string
    message?: string
    meta?: { code?: string; message?: string }
  }
  return candidate?.meta?.code === '55P03'
    || candidate?.code === '55P03'
    || /lock timeout|canceling statement due to lock timeout/i.test(
      `${candidate?.message ?? ''} ${candidate?.meta?.message ?? ''}`,
    )
}

/**
 * Must precede every Contacts-owned read/write in an ownership transaction.
 * A shared cross-owner transaction may first acquire another owner's advisory
 * fence when its documented global order requires that (for example FLT1 ->
 * CNT1); no business row may be read before this admission.
 * The MATERIALIZED CTE and the data dependency force lock_timeout to be set
 * before PostgreSQL evaluates pg_advisory_xact_lock, while both happen in one
 * statement. The transaction-scoped lock is released automatically at end.
 */
export async function admitContactOwnershipTransaction(
  transaction: ContactOwnershipTransaction,
  options: Pick<ContactOwnershipRunOptions, 'lockTimeoutMs'> = {},
): Promise<void> {
  const lockTimeoutMs = boundedInteger(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, 30_000)
  const lockTimeout = `${lockTimeoutMs}ms`

  try {
    await transaction.$queryRaw<Array<{ admitted: boolean }>>`
      WITH "contact_ownership_lock_policy" AS MATERIALIZED (
        SELECT set_config('lock_timeout', ${lockTimeout}, true) AS configured
      )
      SELECT (
        pg_advisory_xact_lock(
          CAST(${CONTACT_OWNERSHIP_ADVISORY_CLASS_ID} AS integer)
            + octet_length(configured) * 0,
          CAST(${CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID} AS integer)
        ) IS NULL
      ) AS admitted
      FROM "contact_ownership_lock_policy"
    `
    admittedTransactions.add(transaction as object)
  } catch (error) {
    if (isLockTimeout(error)) throw new ContactOwnershipBusyError()
    throw error
  }
}

export async function runContactOwnershipTransaction<T>(
  work: (transaction: ContactOwnershipTransaction) => Promise<T>,
  options: ContactOwnershipRunOptions = {},
): Promise<T> {
  const transactionTimeoutMs = boundedInteger(
    options.transactionTimeoutMs,
    DEFAULT_TRANSACTION_TIMEOUT_MS,
    60_000,
  )
  const maxWaitMs = boundedInteger(options.maxWaitMs, DEFAULT_LOCK_TIMEOUT_MS, 30_000)

  return prisma.$transaction(async transaction => {
    await admitContactOwnershipTransaction(transaction, options)
    return work(transaction)
  }, {
    // The advisory admission is the serialization mechanism. READ COMMITTED is
    // intentional: a transaction that waited in its first statement must take
    // a fresh snapshot for the authoritative reads that follow admission.
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: maxWaitMs,
    timeout: transactionTimeoutMs,
  })
}

function assertAdmitted(transaction: ContactOwnershipTransaction): void {
  if (!admittedTransactions.has(transaction as object)) {
    throw new ContactOwnershipInvariantError(
      'Contact ownership row access attempted before advisory admission',
    )
  }
}

function assertBoundedRows(relation: string, rows: readonly unknown[], maximum: number): void {
  if (rows.length > maximum) {
    throw new ContactOwnershipInvariantError(
      `${relation} ownership scope exceeds ${maximum} rows; transaction rolled back`,
    )
  }
}

async function expandContactIds(
  transaction: ContactOwnershipTransaction,
  selector: ContactOwnershipLockSelector,
  maximum: number,
): Promise<string[]> {
  const contactIds = new Set(boundedStrings(selector.contactIds, 'contactIds'))
  const phoneIds = boundedStrings(selector.phoneIds, 'phoneIds')
  const normalizedPhones = boundedStrings(selector.normalizedPhones, 'normalizedPhones')
  const identityIds = boundedStrings(selector.identityIds, 'identityIds')
  const identities = selector.identities ?? []
  const yandexDriverIds = boundedStrings(selector.yandexDriverIds, 'yandexDriverIds')

  if (identities.length > DEFAULT_MAX_ROWS_PER_RELATION) {
    throw new ContactOwnershipInvariantError('identities exceeds the bounded coordinator input')
  }

  const phoneOwnerPredicates: Prisma.Sql[] = []
  if (phoneIds.length > 0) phoneOwnerPredicates.push(Prisma.sql`id IN (${inList(phoneIds)})`)
  if (normalizedPhones.length > 0) {
    phoneOwnerPredicates.push(Prisma.sql`phone IN (${inList(normalizedPhones)})`)
  }
  const identityOwnerPredicates: Prisma.Sql[] = []
  if (identityIds.length > 0) identityOwnerPredicates.push(Prisma.sql`id IN (${inList(identityIds)})`)
  for (const identity of identities) {
    identityOwnerPredicates.push(Prisma.sql`(
      channel = CAST(${identity.channel} AS "ChatChannel")
      AND "externalId" = ${identity.externalId}
    )`)
  }

  const [phoneOwners, identityOwners, driverContacts] = await Promise.all([
    phoneOwnerPredicates.length > 0
      ? transaction.$queryRaw<Array<{ contactId: string }>>(Prisma.sql`
          SELECT "contactId" FROM "ContactPhone"
          WHERE ${Prisma.join(phoneOwnerPredicates, ' OR ')}
          ORDER BY id
          LIMIT ${maximum + 1}
        `)
      : [],
    identityOwnerPredicates.length > 0
      ? transaction.$queryRaw<Array<{ contactId: string }>>(Prisma.sql`
          SELECT "contactId" FROM "ContactIdentity"
          WHERE ${Prisma.join(identityOwnerPredicates, ' OR ')}
          ORDER BY id
          LIMIT ${maximum + 1}
        `)
      : [],
    yandexDriverIds.length > 0
      ? transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT id FROM "Contact"
          WHERE "yandexDriverId" IN (${inList(yandexDriverIds)})
          ORDER BY id
          LIMIT ${maximum + 1}
        `)
      : [],
  ])

  assertBoundedRows('ContactPhone discovery', phoneOwners, maximum)
  assertBoundedRows('ContactIdentity discovery', identityOwners, maximum)
  assertBoundedRows('Contact driver discovery', driverContacts, maximum)
  for (const row of phoneOwners) contactIds.add(row.contactId)
  for (const row of identityOwners) contactIds.add(row.contactId)
  for (const row of driverContacts) contactIds.add(row.id)

  let frontier = [...contactIds]
  for (let depth = 0; frontier.length > 0 && depth < MAX_CONTACT_MERGE_DEPTH; depth += 1) {
    const edges = await transaction.$queryRaw<Array<{ survivorId: string; mergedId: string }>>(
      Prisma.sql`
        SELECT "survivorId", "mergedId" FROM "ContactMerge"
        WHERE action = 'merge'
          AND ("survivorId" IN (${inList(frontier)}) OR "mergedId" IN (${inList(frontier)}))
        ORDER BY id
        LIMIT ${maximum + 1}
      `,
    )
    assertBoundedRows('ContactMerge discovery', edges, maximum)
    const next: string[] = []
    for (const edge of edges) {
      for (const id of [edge.survivorId, edge.mergedId]) {
        if (!contactIds.has(id)) {
          contactIds.add(id)
          next.push(id)
        }
      }
    }
    assertBoundedRows('Contact closure', [...contactIds], maximum)
    frontier = next
  }
  if (frontier.length > 0) {
    throw new ContactOwnershipInvariantError(
      `Contact merge closure exceeds ${MAX_CONTACT_MERGE_DEPTH} levels`,
    )
  }

  return [...contactIds].sort()
}

function inList(values: readonly string[]): Prisma.Sql {
  return Prisma.join(values.map(value => Prisma.sql`${value}`))
}

/**
 * Locks every existing ownership row in one deterministic global order.
 * Discovery reads are permitted only after global admission and are bounded;
 * all business decisions must be made after this function returns.
 */
export async function lockContactOwnershipRows(
  transaction: ContactOwnershipTransaction,
  selector: ContactOwnershipLockSelector,
  options: Pick<ContactOwnershipRunOptions, 'maxRowsPerRelation'> = {},
): Promise<ContactOwnershipLockedScope> {
  assertAdmitted(transaction)
  const maximum = boundedInteger(
    options.maxRowsPerRelation,
    DEFAULT_MAX_ROWS_PER_RELATION,
    2_048,
  )
  const explicitPhoneIds = boundedStrings(selector.phoneIds, 'phoneIds')
  const explicitPhones = boundedStrings(selector.normalizedPhones, 'normalizedPhones')
  const explicitIdentityIds = boundedStrings(selector.identityIds, 'identityIds')
  const explicitMergeIds = boundedStrings(selector.mergeIds, 'mergeIds')
  const contactIds = await expandContactIds(transaction, selector, maximum)

  const lockedContacts = contactIds.length > 0
    ? await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM "Contact"
        WHERE id IN (${inList(contactIds)})
        ORDER BY id
        LIMIT ${maximum + 1}
        FOR UPDATE
      `)
    : []
  assertBoundedRows('Contact', lockedContacts, maximum)

  const phonePredicates: Prisma.Sql[] = []
  if (contactIds.length > 0) phonePredicates.push(Prisma.sql`"contactId" IN (${inList(contactIds)})`)
  if (explicitPhoneIds.length > 0) phonePredicates.push(Prisma.sql`id IN (${inList(explicitPhoneIds)})`)
  if (explicitPhones.length > 0) phonePredicates.push(Prisma.sql`phone IN (${inList(explicitPhones)})`)
  const lockedPhones = phonePredicates.length > 0
    ? await transaction.$queryRaw<Array<{ id: string; phone: string }>>(Prisma.sql`
        SELECT id, phone FROM "ContactPhone"
        WHERE ${Prisma.join(phonePredicates, ' OR ')}
        ORDER BY id
        LIMIT ${maximum + 1}
        FOR UPDATE
      `)
    : []
  assertBoundedRows('ContactPhone', lockedPhones, maximum)

  const phoneIds = [...new Set([...explicitPhoneIds, ...lockedPhones.map(row => row.id)])].sort()
  const identityPredicates: Prisma.Sql[] = []
  if (contactIds.length > 0) identityPredicates.push(Prisma.sql`"contactId" IN (${inList(contactIds)})`)
  if (explicitIdentityIds.length > 0) identityPredicates.push(Prisma.sql`id IN (${inList(explicitIdentityIds)})`)
  if (phoneIds.length > 0) identityPredicates.push(Prisma.sql`"phoneId" IN (${inList(phoneIds)})`)
  for (const identity of selector.identities ?? []) {
    identityPredicates.push(Prisma.sql`(channel = CAST(${identity.channel} AS "ChatChannel") AND "externalId" = ${identity.externalId})`)
  }
  const lockedIdentities = identityPredicates.length > 0
    ? await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM "ContactIdentity"
        WHERE ${Prisma.join(identityPredicates, ' OR ')}
        ORDER BY id
        LIMIT ${maximum + 1}
        FOR UPDATE
      `)
    : []
  assertBoundedRows('ContactIdentity', lockedIdentities, maximum)

  const mergePredicates: Prisma.Sql[] = []
  if (contactIds.length > 0) {
    mergePredicates.push(Prisma.sql`"survivorId" IN (${inList(contactIds)})`)
    mergePredicates.push(Prisma.sql`"mergedId" IN (${inList(contactIds)})`)
  }
  if (explicitMergeIds.length > 0) mergePredicates.push(Prisma.sql`id IN (${inList(explicitMergeIds)})`)
  const lockedMerges = mergePredicates.length > 0
    ? await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM "ContactMerge"
        WHERE ${Prisma.join(mergePredicates, ' OR ')}
        ORDER BY id
        LIMIT ${maximum + 1}
        FOR UPDATE
      `)
    : []
  assertBoundedRows('ContactMerge', lockedMerges, maximum)

  return {
    contactIds: [...new Set([...contactIds, ...lockedContacts.map(row => row.id)])].sort(),
    phoneIds,
    normalizedPhones: [...new Set([
      ...explicitPhones,
      ...lockedPhones.map(row => row.phone),
    ])].sort(),
    identityIds: [...new Set([
      ...explicitIdentityIds,
      ...lockedIdentities.map(row => row.id),
    ])].sort(),
    mergeIds: [...new Set([...explicitMergeIds, ...lockedMerges.map(row => row.id)])].sort(),
  }
}

/** Verify the serial-valid ownership state before allowing commit. */
export async function assertContactOwnershipPostconditions(
  transaction: ContactOwnershipTransaction,
  scope: ContactOwnershipLockedScope,
): Promise<void> {
  assertAdmitted(transaction)

  if (scope.normalizedPhones.length > 0) {
    const duplicate = await transaction.$queryRaw<Array<{ phone: string }>>(Prisma.sql`
      SELECT phone.phone FROM "ContactPhone" AS phone
      JOIN "Contact" AS contact ON contact.id = phone."contactId"
      WHERE phone.phone IN (${inList(scope.normalizedPhones)}) AND phone."isActive" = true
      GROUP BY phone.phone
      HAVING COUNT(DISTINCT phone."contactId") > 1
        AND BOOL_OR(COALESCE(
          contact."customFields" -> 'phoneEvidenceByPhoneId' -> phone.id ->> 'resolutionState',
          'unknown'
        ) = 'unique')
      ORDER BY phone.phone
      LIMIT 1
    `)
    if (duplicate[0]) {
      throw new ContactOwnershipInvariantError(
        `Phone ${duplicate[0].phone} has duplicate active ownership`,
      )
    }
  }

  if (scope.contactIds.length === 0) return
  const [
    duplicatePrimary,
    invalidPrimary,
    unpointedPrimary,
    crossOwnerIdentity,
    dirtyArchive,
  ] = await Promise.all([
    transaction.$queryRaw<Array<{ contactId: string }>>(Prisma.sql`
      SELECT "contactId" FROM "ContactPhone"
      WHERE "contactId" IN (${inList(scope.contactIds)})
        AND "isActive" = true
        AND "isPrimary" = true
      GROUP BY "contactId"
      HAVING COUNT(*) > 1
      ORDER BY "contactId"
      LIMIT 1
    `),
    transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT contact.id FROM "Contact" AS contact
      LEFT JOIN "ContactPhone" AS phone ON phone.id = contact."primaryPhoneId"
      WHERE contact.id IN (${inList(scope.contactIds)})
        AND contact."primaryPhoneId" IS NOT NULL
        AND (phone.id IS NULL OR phone."contactId" <> contact.id
          OR phone."isActive" = false OR phone."isPrimary" = false)
      ORDER BY contact.id
      LIMIT 1
    `),
    transaction.$queryRaw<Array<{ id: string; contactId: string }>>(Prisma.sql`
      SELECT phone.id, phone."contactId" FROM "ContactPhone" AS phone
      JOIN "Contact" AS contact ON contact.id = phone."contactId"
      WHERE contact.id IN (${inList(scope.contactIds)})
        AND phone."isActive" = true
        AND phone."isPrimary" = true
        AND (contact."primaryPhoneId" IS NULL OR contact."primaryPhoneId" <> phone.id)
      ORDER BY phone.id
      LIMIT 1
    `),
    transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT identity.id FROM "ContactIdentity" AS identity
      LEFT JOIN "ContactPhone" AS phone ON phone.id = identity."phoneId"
      WHERE identity."contactId" IN (${inList(scope.contactIds)})
        AND identity."phoneId" IS NOT NULL
        AND (phone.id IS NULL OR phone."contactId" <> identity."contactId")
      ORDER BY identity.id
      LIMIT 1
    `),
    transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT contact.id FROM "Contact" AS contact
      WHERE contact.id IN (${inList(scope.contactIds)})
        AND contact."isArchived" = true
        AND (
          NOT EXISTS (
            SELECT 1 FROM "ContactMerge" AS edge
            WHERE edge."mergedId" = contact.id AND edge.action = 'merge'
          )
          OR EXISTS (SELECT 1 FROM "ContactPhone" AS phone WHERE phone."contactId" = contact.id)
          OR EXISTS (SELECT 1 FROM "ContactIdentity" AS identity WHERE identity."contactId" = contact.id)
          OR EXISTS (SELECT 1 FROM "Chat" AS chat WHERE chat."contactId" = contact.id)
          OR EXISTS (SELECT 1 FROM "Task" AS task WHERE task."contactId" = contact.id)
          OR EXISTS (SELECT 1 FROM "Call" AS call WHERE call."contactId" = contact.id)
          OR EXISTS (SELECT 1 FROM "Driver" AS driver WHERE driver."contactId" = contact.id)
        )
      ORDER BY contact.id
      LIMIT 1
    `),
  ])
  if (duplicatePrimary[0]) {
    throw new ContactOwnershipInvariantError(
      `Contact ${duplicatePrimary[0].contactId} has multiple active primary phones`,
    )
  }
  if (invalidPrimary[0]) {
    throw new ContactOwnershipInvariantError(
      `Contact ${invalidPrimary[0].id} has an invalid primaryPhoneId`,
    )
  }
  if (unpointedPrimary[0]) {
    throw new ContactOwnershipInvariantError(
      `Primary phone ${unpointedPrimary[0].id} is not selected by Contact ${unpointedPrimary[0].contactId}`,
    )
  }
  if (crossOwnerIdentity[0]) {
    throw new ContactOwnershipInvariantError(
      `Identity ${crossOwnerIdentity[0].id} references a phone owned by another Contact`,
    )
  }
  if (dirtyArchive[0]) {
    throw new ContactOwnershipInvariantError(
      `Archived contact ${dirtyArchive[0].id} has no accepted clean merge edge`,
    )
  }
}
