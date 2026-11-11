// The Contacts-owned handler behind contacts.ContactPersonCardQuery.v1.
//
// For one exact Contact id it decides whether a verified server-side principal
// may see the person card, and projects everything Contacts owns about that
// person. It reads nothing by phone, name, username or provider id, consults no
// Driver, Chat or provider table, and writes nothing.
//
// The protocol, in order; every non-confirmed answer returns before any further
// read and carries no data except the canonical id of a redirect:
//   1. the authority port's verified principal; none → forbidden. A client-held
//      identifier (crm_user_id, a header, a body field) is never an input here;
//   2. the query is parsed; only an exact Contact id is accepted;
//   3. the principal may read this Contact, else forbidden (nothing is read);
//   4. the source of exactly that Contact, with its lineage, in one snapshot;
//   5. a source that is gone → missing; one merged into another Contact →
//      redirected to the canonical id; an archived one with no redirect → missing;
//   6. a source that is not the Contact asked for → refused;
//   7. confirmed, with the card.
import {
  CONTACT_PERSON_CARD_RESULT_V1,
  parseContactPersonCardQueryV1,
  type ContactPersonCardAccountV1,
  type ContactPersonCardCandidateV1,
  type ContactPersonCardChannelV1,
  type ContactPersonCardConflictV1,
  type ContactPersonCardPhoneV1,
  type ContactPersonCardResultV1,
  type ContactPersonCardActorV1,
  type ContactPersonCardLinkEventKindV1,
  type ContactPersonCardLinkEventV1,
  type ContactPersonCardStatusV1,
  type ContactPersonCardV1,
  type ContactPersonConfirmationV1,
} from '@/contracts/contacts/v1'
import { buildProviderNeutralContactDisplayV1 } from '../public/v1/contact-display-policy'
import {
  confirmedPersonNameV1,
  contactAutomationState,
  hasOpenDriverPersonContradictionV1,
  identityEvidenceState,
  jsonRecord,
  phoneEvidenceState,
} from '../public/v1/contact-evidence-state'
import { resolveContactIdentityConflictStateV1 } from '../public/v1/contact-identity-conflict-state'

/**
 * A principal Contacts' read authority admitted from server-side state: its kind
 * and the ВУ view it was granted. A principal without a view gets 'last4'.
 */
export type ContactPersonCardPrincipalV1 = { readonly kind: string; readonly licenceView?: 'full' | 'last4' }

export interface ContactPersonCardAuthorityPortV1 {
  /** The verified principal of the current request, or null. Never derived from a client-held identifier. */
  currentPrincipal(): Promise<ContactPersonCardPrincipalV1 | null>
  /** Whether the principal may read this exact Contact. Asked before any Contact read. */
  mayReadContact(principal: ContactPersonCardPrincipalV1, contactId: string): Promise<boolean>
}

/** Exactly what the card needs from one Contact and its lineage. Contacts-owned models only. */
export type ContactPersonCardSourceV1 = {
  id: string
  displayName: string | null
  displayNameSource: string
  masterSource: string
  primaryPhoneId: string | null
  isArchived: boolean
  customFields: unknown
  mainDriverId: string | null
  yandexDriverId: string | null
  phones: Array<{ id: string; phone: string; isPrimary: boolean; isActive: boolean; verifiedAt: Date | string | null }>
  identities: Array<{
    id: string
    channel: string
    externalId: string
    displayName: string | null
    isActive: boolean
    source: string
    metadata: unknown
    phoneId: string | null
    reachabilityStatus: string | null
    reachabilityCheckedAt: Date | string | null
    createdAt: Date | string
  }>
  /** The resolved lineage of this id; null when the resolver found no Contact. */
  lineage: { canonicalContactId: string; contactIds: string[] } | null
  /** Merge events touching any Contact of the lineage, newest first, bounded. */
  merges: Array<{
    id: string
    action: string
    reason: string
    mergedBy: string
    createdAt: Date | string
    mergedId: string
    survivorId: string
    /** snapshotBefore._merge.automated as stored; null when the record does not say. */
    automated: boolean | null
    /** snapshotBefore._merge.recoveryState / recoveredAt as stored. */
    recoveryState: string | null
    recoveredAt: Date | string | null
  }>
  /** ContactCommunicationPolicyEvent rows of the lineage, newest first, bounded. */
  policyEvents: Array<{
    eventId: string
    cause: string
    actor: string
    recordedAt: Date | string
    afterDenyAll: boolean
    afterDenyMessage: boolean
    afterDenyVoice: boolean
  }>
}

export interface ContactPersonCardSourcePortV1 {
  /** The source of exactly this Contact id, or null. One snapshot, reads only. */
  findContactPersonCardSource(contactId: string): Promise<ContactPersonCardSourceV1 | null>
}

function answer(status: Exclude<ContactPersonCardStatusV1, 'confirmed' | 'redirected'>): ContactPersonCardResultV1 {
  return { contract: CONTACT_PERSON_CARD_RESULT_V1, status }
}

function isPrincipal(value: unknown): value is ContactPersonCardPrincipalV1 {
  return typeof value === 'object' && value !== null
    && typeof (value as { kind?: unknown }).kind === 'string' && (value as { kind: string }).kind !== ''
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function exactId(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value.trim() === value ? value : null
}

function enumOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : fallback
}

type StoredConfirmation = {
  status: string
  profileClusterKey: string | null
  representativeDriverId: string | null
  reconciliationContactId: string | null
}

function storedConfirmations(customFields: unknown): StoredConfirmation[] {
  const stored = jsonRecord(customFields).driverConfirmations
  if (!Array.isArray(stored)) return []
  return stored.map(item => {
    const record = jsonRecord(item)
    return {
      status: typeof record.status === 'string' ? record.status : '',
      profileClusterKey: exactId(record.profileClusterKey),
      representativeDriverId: exactId(record.representativeDriverId),
      reconciliationContactId: exactId(record.reconciliationContactId),
    }
  })
}

/**
 * Contacts' confirmation state about which person this Contact is. It never
 * invents a person: an open contradiction wins over everything, a pending pair
 * reconciliation over a confirmation, and a name is reported only when
 * confirmedPersonNameV1 proves it.
 */
export function projectPersonConfirmationV1(customFields: unknown): ContactPersonConfirmationV1 {
  const records = storedConfirmations(customFields)
  const confirmed = records.filter(record => record.status === 'confirmed')
  const clusterKeys = new Set(confirmed.map(record => record.profileClusterKey).filter((key): key is string => key !== null))
  const representatives = new Set(confirmed.map(record => record.representativeDriverId).filter((id): id is string => id !== null))
  const state = hasOpenDriverPersonContradictionV1(customFields) || records.some(record => record.status === 'contradicted')
    ? 'contradiction'
    : records.some(record => record.status === 'needs_reconciliation')
      ? 'needs_reconciliation'
      : confirmed.length > 0 ? 'confirmed' : 'unconfirmed'
  return {
    state,
    confirmedPersonName: confirmedPersonNameV1(customFields),
    confirmedClusterKeyCount: clusterKeys.size,
    representativeDriverId: state === 'confirmed' && representatives.size === 1 ? [...representatives][0] : null,
  }
}

function projectPhones(source: ContactPersonCardSourceV1): ContactPersonCardPhoneV1[] {
  return source.phones.map(phone => {
    const evidence = phoneEvidenceState(source.customFields, phone.id, {
      phone: phone.phone,
      isActive: phone.isActive,
      verifiedAt: phone.verifiedAt,
    })
    return {
      phoneId: phone.id,
      phone: phone.phone,
      isPrimary: phone.isPrimary === true || source.primaryPhoneId === phone.id,
      isActive: phone.isActive !== false,
      lifecycle: evidence.lifecycle,
      trust: evidence.trust,
      freshness: evidence.freshness,
      resolutionState: evidence.resolutionState,
      verifiedAt: iso(phone.verifiedAt),
      lastSeenAt: evidence.lastSeenAt,
    }
  })
}

function compareAccounts(left: ContactPersonCardAccountV1, right: ContactPersonCardAccountV1): number {
  if (left.isActive !== right.isActive) return left.isActive ? -1 : 1
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1
  return left.identityId < right.identityId ? -1 : left.identityId > right.identityId ? 1 : 0
}

function projectChannels(
  source: ContactPersonCardSourceV1,
  conflictedIdentityIds: ReadonlySet<string>,
): ContactPersonCardChannelV1[] {
  const byChannel = new Map<string, ContactPersonCardAccountV1[]>()
  for (const identity of source.identities) {
    const evidence = identityEvidenceState(identity.metadata)
    const metadata = jsonRecord(identity.metadata)
    const account: ContactPersonCardAccountV1 = {
      identityId: identity.id,
      externalId: identity.externalId,
      displayName: identity.displayName ?? null,
      username: typeof metadata.username === 'string' && metadata.username.trim() !== '' ? metadata.username : null,
      isActive: identity.isActive !== false,
      source: enumOf(identity.source, ['auto', 'manual', 'yandex'] as const, 'unknown'),
      origin: evidence.origin,
      conflictState: evidence.conflictState === 'conflicted' || conflictedIdentityIds.has(identity.id) ? 'conflicted' : 'clear',
      reachabilityStatus: enumOf(identity.reachabilityStatus, ['confirmed', 'unreachable', 'unknown'] as const, 'unknown'),
      reachabilityCheckedAt: iso(identity.reachabilityCheckedAt),
      linkedPhoneId: identity.phoneId,
      aliasCount: evidence.providerAliasValues.length,
      createdAt: iso(identity.createdAt) ?? '',
    }
    const channel = String(identity.channel)
    byChannel.set(channel, [...(byChannel.get(channel) ?? []), account])
  }
  return [...byChannel.entries()]
    // Code-point order, never locale order: the same person always lists the same way.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([channel, accounts]) => ({ channel, accounts: accounts.sort(compareAccounts) }))
}

function projectConflicts(source: ContactPersonCardSourceV1): {
  conflicts: ContactPersonCardConflictV1[]
  conflictedIdentityIds: Set<string>
  hasOpenConflict: boolean
  hasPersonBlockingConflict: boolean
} {
  const state = resolveContactIdentityConflictStateV1({
    customFields: source.customFields,
    identities: source.identities.map(identity => ({
      id: identity.id,
      channel: String(identity.channel),
      externalId: identity.externalId,
      isActive: identity.isActive,
      metadata: identity.metadata,
    })),
  })
  const journal = jsonRecord(source.customFields).identityConflicts
  const journalRecords = Array.isArray(journal) ? journal.map(jsonRecord) : []
  const conflictedIdentityIds = new Set<string>()
  const conflicts = state.entries.map(entry => {
    const record = entry.journalIndex === null ? null : journalRecords[entry.journalIndex] ?? null
    const otherContactId = record === null ? null : exactId(record.otherContactId)
    if (entry.status === 'open' && entry.identityId !== null) conflictedIdentityIds.add(entry.identityId)
    return {
      origin: entry.origin,
      identityId: entry.identityId,
      identityState: entry.identityState,
      channel: entry.channel,
      conflictClass: entry.conflictClass,
      scope: entry.scope,
      status: entry.status,
      personBlocking: entry.personBlocking,
      otherContactId: otherContactId === source.id ? null : otherContactId,
      detectedAt: entry.detectedAt,
    }
  })
  return {
    conflicts,
    conflictedIdentityIds,
    hasOpenConflict: state.hasOpenConflict,
    hasPersonBlockingConflict: state.hasPersonBlockingConflict,
  }
}

/**
 * Other Contacts that Contacts itself already recorded as possibly the same
 * person: a pending pair reconciliation and an open conflict naming another
 * Contact. Nothing is matched here by name or phone; a candidate is a stored
 * fact, and only its id crosses.
 */
function projectCandidates(source: ContactPersonCardSourceV1, conflicts: ContactPersonCardConflictV1[]): ContactPersonCardCandidateV1[] {
  const seen = new Set<string>([source.id])
  const candidates: ContactPersonCardCandidateV1[] = []
  for (const record of storedConfirmations(source.customFields)) {
    if (record.status !== 'needs_reconciliation' || record.reconciliationContactId === null) continue
    if (seen.has(record.reconciliationContactId)) continue
    seen.add(record.reconciliationContactId)
    candidates.push({ contactId: record.reconciliationContactId, basis: 'needs_reconciliation' })
  }
  for (const conflict of conflicts) {
    if (conflict.status !== 'open' || conflict.otherContactId === null || seen.has(conflict.otherContactId)) continue
    seen.add(conflict.otherContactId)
    candidates.push({ contactId: conflict.otherContactId, basis: 'open_conflict' })
  }
  return candidates
}

/** Projects one Contact source into the person card. Pure. */
/** A stored actor string as one of the closed kinds; a free-text actor never crosses. */
export function contactPersonCardActorV1(stored: unknown): ContactPersonCardActorV1 {
  if (typeof stored !== 'string') return { kind: 'unknown' }
  const staff = /^staff:([A-Za-z0-9_-]{1,64})$/u.exec(stored)
  if (staff) return { kind: 'staff', userId: staff[1] }
  if (stored === 'identity-access:integration-admin-session') return { kind: 'integration_admin' }
  if (/^system:[a-z0-9_-]{1,64}$/u.test(stored)) return { kind: 'system' }
  return { kind: 'unknown' }
}

function modeOf(actor: ContactPersonCardActorV1): ContactPersonCardLinkEventV1['mode'] {
  if (actor.kind === 'staff' || actor.kind === 'integration_admin') return 'manual'
  if (actor.kind === 'system') return 'automatic'
  return 'unknown'
}

function restrictionDetail(event: { afterDenyAll: boolean; afterDenyMessage: boolean; afterDenyVoice: boolean }): string {
  if (event.afterDenyAll) return 'deny_all'
  if (event.afterDenyMessage && event.afterDenyVoice) return 'deny_message_voice'
  if (event.afterDenyMessage) return 'deny_message'
  if (event.afterDenyVoice) return 'deny_voice'
  return 'none'
}

/**
 * The stored link changes: merge records, the phone evidence audit trail, the
 * driver-person confirmations and the communication policy events. Each event
 * is one stored record; none is inferred from the current state.
 */
function projectLinkHistory(source: ContactPersonCardSourceV1, lineageIds: string[]): ContactPersonCardLinkEventV1[] {
  const events: ContactPersonCardLinkEventV1[] = []
  for (const merge of source.merges) {
    if (!lineageIds.includes(merge.survivorId) && !lineageIds.includes(merge.mergedId)) continue
    const at = iso(merge.createdAt)
    if (at === null) continue
    const actor = contactPersonCardActorV1(merge.mergedBy)
    const mode = merge.automated === true ? 'automatic' : merge.automated === false ? 'manual' : modeOf(actor)
    events.push({ kind: merge.action === 'unmerge' ? 'contacts_unmerged' : 'contacts_merged', at, subject: null, detail: null, mode, actor })
    const recoveredAt = merge.recoveryState === 'recovered' ? iso(merge.recoveredAt) : null
    if (recoveredAt !== null) events.push({ kind: 'merge_recovered', at: recoveredAt, subject: null, detail: null, mode: 'unknown', actor: { kind: 'unknown' } })
  }
  const evidenceByPhone = jsonRecord(jsonRecord(source.customFields).phoneEvidenceByPhoneId)
  for (const phone of source.phones) {
    const trail = jsonRecord(evidenceByPhone[phone.id]).auditTrail
    if (!Array.isArray(trail)) continue
    for (const raw of trail) {
      const entry = jsonRecord(raw)
      const at = iso(typeof entry.createdAt === 'string' ? entry.createdAt : null)
      if (at === null) continue
      const after = jsonRecord(entry.afterState)
      const before = jsonRecord(entry.beforeState)
      const actor = contactPersonCardActorV1(entry.actor)
      let kind: ContactPersonCardLinkEventKindV1
      if (entry.action === 'add_or_verify') kind = 'phone_added_or_verified'
      else if (entry.action === 'attach_identity') kind = 'identity_attached_to_phone'
      else if (entry.action === 'set_state' && after.lifecycle === 'removed') kind = 'phone_removed'
      else if (entry.action === 'set_state' && after.isPrimary === true && before.isPrimary !== true) kind = 'phone_made_primary'
      else if (entry.action === 'set_state') kind = 'phone_state_changed'
      else continue
      events.push({ kind, at, subject: phone.phone, detail: null, mode: modeOf(actor), actor })
    }
  }
  const confirmations = jsonRecord(source.customFields).driverConfirmations
  if (Array.isArray(confirmations)) {
    for (const raw of confirmations) {
      const record = jsonRecord(raw)
      const at = iso(typeof record.confirmedAt === 'string' ? record.confirmedAt : null)
      if (at === null) continue
      const actor = contactPersonCardActorV1(record.confirmedBy)
      const status = enumOf(record.status, ['confirmed', 'contradicted', 'revoked', 'needs_reconciliation'] as const, 'confirmed')
      events.push({ kind: 'driver_profile_confirmed', at, subject: null, detail: status, mode: modeOf(actor), actor })
    }
  }
  for (const event of source.policyEvents) {
    const at = iso(event.recordedAt)
    if (at === null) continue
    const actor = contactPersonCardActorV1(event.actor)
    events.push({ kind: 'communication_policy_changed', at, subject: null, detail: restrictionDetail(event), mode: modeOf(actor), actor })
  }
  return events
    .sort((left, right) => (left.at > right.at ? -1 : left.at < right.at ? 1 : 0))
    .slice(0, 50)
}

export function buildContactPersonCardV1(source: ContactPersonCardSourceV1): ContactPersonCardV1 {
  const automation = contactAutomationState(source.customFields)
  const phones = projectPhones(source)
  const display = buildProviderNeutralContactDisplayV1({
    contact: {
      displayName: source.displayName,
      displayNameSource: source.displayNameSource,
      primaryPhoneId: source.primaryPhoneId,
      canonicalPinnedAt: automation.canonicalPinnedAt,
      phones: phones.map(phone => ({ id: phone.phoneId, phone: phone.phone, isPrimary: phone.isPrimary, isActive: phone.isActive, lifecycle: phone.lifecycle })),
      identities: source.identities.map(identity => ({ channel: identity.channel, displayName: identity.displayName, isActive: identity.isActive })),
    },
    confirmedPersonName: confirmedPersonNameV1(source.customFields),
  })
  const { conflicts, conflictedIdentityIds, hasOpenConflict, hasPersonBlockingConflict } = projectConflicts(source)
  const lineageIds = source.lineage?.contactIds ?? [source.id]
  const mergeHistory = source.merges
    .filter(merge => lineageIds.includes(merge.survivorId) || lineageIds.includes(merge.mergedId))
    .map(merge => ({
      mergeId: merge.id,
      action: enumOf(merge.action, ['merge', 'unmerge'] as const, 'merge'),
      reason: merge.reason,
      mergedBy: merge.mergedBy,
      createdAt: iso(merge.createdAt) ?? '',
      mergedContactId: merge.mergedId,
      survivorContactId: merge.survivorId,
    }))
    .sort((left, right) => (left.createdAt > right.createdAt ? -1 : left.createdAt < right.createdAt ? 1 : 0))
    .slice(0, 50)
  return {
    contactId: source.id,
    displayName: display.displayName,
    displayTitle: display.displayTitle,
    primaryPhone: display.primaryPhone,
    displayNameSource: source.displayNameSource,
    source: source.masterSource,
    personConfirmation: projectPersonConfirmationV1(source.customFields),
    mainDriverId: source.mainDriverId,
    legacyYandexDriverId: source.yandexDriverId,
    phones,
    channels: projectChannels(source, conflictedIdentityIds),
    lineage: {
      canonicalContactId: source.lineage?.canonicalContactId ?? source.id,
      contactIds: [...lineageIds].sort(),
      mergedFromCount: source.merges.filter(merge => merge.action === 'merge' && merge.survivorId === source.id).length,
      mergeHistory,
    },
    conflicts,
    hasOpenConflict,
    hasPersonBlockingConflict,
    candidates: projectCandidates(source, conflicts),
    automation: {
      doNotMerge: automation.doNotMerge,
      canonicalPinned: automation.canonicalPinnedAt !== null,
      mergeRecoveryState: automation.mergeRecoveryState,
    },
    isArchived: source.isArchived,
    linkHistory: projectLinkHistory(source, lineageIds),
  }
}

export function createContactPersonCardHandlerV1(ports: {
  authority: ContactPersonCardAuthorityPortV1
  cardSource: ContactPersonCardSourcePortV1
}) {
  return async function readContactPersonCardV1(query: unknown): Promise<ContactPersonCardResultV1> {
    const principal = await ports.authority.currentPrincipal()
    if (!isPrincipal(principal)) return answer('forbidden')
    const { contactId } = parseContactPersonCardQueryV1(query)
    if (await ports.authority.mayReadContact(principal, contactId) !== true) return answer('forbidden')
    const source = await ports.cardSource.findContactPersonCardSource(contactId)
    if (source === null) return answer('missing')
    if (source.id !== contactId) return answer('refused')
    const redirect = contactAutomationState(source.customFields).mergedIntoContactId
    const canonical = source.lineage?.canonicalContactId ?? null
    if (redirect !== null || (canonical !== null && canonical !== contactId)) {
      const target = canonical ?? redirect
      // A lineage that cannot name a canonical Contact is not followed blindly.
      if (target === null || target === contactId) return answer('refused')
      return { contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'redirected', canonicalContactId: target }
    }
    if (source.isArchived === true) return answer('missing')
    return {
      contract: CONTACT_PERSON_CARD_RESULT_V1,
      status: 'confirmed',
      card: buildContactPersonCardV1(source),
      // Fail closed: only an explicit 'full' grant shows the full ВУ.
      licenceView: principal.licenceView === 'full' ? 'full' : 'last4',
    }
  }
}
