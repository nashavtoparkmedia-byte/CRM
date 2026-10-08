// Contact communication restrictions foundation (Contact Identity epic).
//
// The Contacts-owned standing restriction of a canonical Contact: whether the
// company may communicate with this person at all, by message, or by voice.
// This file is the whole V1 policy semantic — the fail-closed permission read,
// the OR composition a merge applies, the request digest that makes a mutation
// idempotent, the mutation decision order and the rule that decides whether an
// automated merge recovery may restore the survivor's pre-merge flags —
// expressed over ports, so that a test can drive every branch without a
// database and the one Prisma adapter stays a thin client of it.
//
// It is NOT reachability ("can I reach them now?"), NOT Communication
// Orchestration ("which channel?") and NOT enforcement: nothing here sends,
// calls, routes or names a provider, a ProviderAccount, a Transport, a
// ConversationRoute or a channel identity. The only identifiers are the Contact
// id and the effect class, and canonicalization is delegated to the existing
// Contact lineage handler rather than resolved a second time.

import { createHash } from 'node:crypto'

import {
  CONTACT_COMMUNICATION_PERMISSION_RESULT_V1,
  SET_CONTACT_COMMUNICATION_POLICY_RESULT_V1,
  isContactCommunicationClassV1,
  parseContactCommunicationPermissionQueryV1,
  parseSetContactCommunicationPolicyCommandV1,
  type ContactCommunicationClassV1,
  type ContactCommunicationPermissionReasonV1,
  type ContactCommunicationPermissionResultV1,
  type ContactCommunicationRestrictionStateV1,
  type SetContactCommunicationPolicyCommandV1,
  type SetContactCommunicationPolicyResultV1,
} from '@/contracts/contacts/v1'

import type { ContactLineageV1 } from './contact-lineage-handler'

/** A persisted policy row: the three flags plus the version they were written at. */
export type ContactCommunicationPolicySnapshotV1 = ContactCommunicationRestrictionStateV1 & {
  version: number
}

export type ContactCommunicationPolicyEventCauseV1 = 'mutation' | 'merge' | 'merge_recovery'

/** Everything one append-only policy event records. */
export type ContactCommunicationPolicyEventInputV1 = {
  contactId: string
  cause: ContactCommunicationPolicyEventCauseV1
  version: number
  previousVersion: number | null
  before: ContactCommunicationRestrictionStateV1 | null
  after: ContactCommunicationRestrictionStateV1
  actor: string
  reason: string
  mutationRequestId: string | null
  requestDigest: string | null
  mergeId: string | null
  sourceContactId: string | null
}

/** The merge evidence recorded next to the merge snapshot so recovery can prove what the merge did. */
export type ContactMergeCommunicationPolicyEvidenceV1 = {
  sourceBefore: ContactCommunicationPolicySnapshotV1 | null
  survivorBefore: ContactCommunicationPolicySnapshotV1 | null
  /** The survivor row the merge wrote, or null when neither side had a policy and nothing was written. */
  composed: ContactCommunicationPolicySnapshotV1 | null
}

export const CONTACT_COMMUNICATION_NO_RESTRICTION_V1: Readonly<ContactCommunicationRestrictionStateV1> = Object.freeze({
  denyAll: false,
  denyMessage: false,
  denyVoice: false,
})

/** The actor recorded when the automated merge recovery itself writes a policy version. */
export const CONTACT_COMMUNICATION_MERGE_RECOVERY_ACTOR_V1 = 'contacts:automated-merge-recovery'
/** The actor recorded for a merge whose command carried no usable mergedBy. */
export const CONTACT_COMMUNICATION_MERGE_ACTOR_FALLBACK_V1 = 'contacts:contact-merge'
/** The longest event chain a recovery will inspect; a longer one fails closed instead of being read in part. */
export const CONTACT_COMMUNICATION_RECOVERY_EVENT_BOUND_V1 = 512

/** Exactly the three flags, whatever else the carrier object holds. */
export function restrictionStateOfV1(value: ContactCommunicationRestrictionStateV1): ContactCommunicationRestrictionStateV1 {
  return {
    denyAll: value.denyAll === true,
    denyMessage: value.denyMessage === true,
    denyVoice: value.denyVoice === true,
  }
}

export function sameRestrictionStateV1(
  left: ContactCommunicationRestrictionStateV1 | null,
  right: ContactCommunicationRestrictionStateV1 | null,
): boolean {
  if (left === null || right === null) return left === right
  return left.denyAll === right.denyAll
    && left.denyMessage === right.denyMessage
    && left.denyVoice === right.denyVoice
}

export function sameContactCommunicationPolicySnapshotV1(
  left: ContactCommunicationPolicySnapshotV1 | null,
  right: ContactCommunicationPolicySnapshotV1 | null,
): boolean {
  if (left === null || right === null) return left === right
  return left.version === right.version && sameRestrictionStateV1(left, right)
}

export type ContactCommunicationRestrictionVerdictV1 = {
  restricted: boolean
  reason: 'no_restriction' | 'restricted_all' | 'restricted_message' | 'restricted_voice'
}

/**
 * Whether the standing policy restricts one effect class. `denyAll` wins over the
 * class flag; a missing row restricts nothing. There is no other input: a
 * channel, a provider or a reachability fact can never widen or narrow this.
 */
export function evaluateContactCommunicationRestrictionV1(
  state: ContactCommunicationRestrictionStateV1 | null,
  communicationClass: ContactCommunicationClassV1,
): ContactCommunicationRestrictionVerdictV1 {
  if (state === null) return { restricted: false, reason: 'no_restriction' }
  if (state.denyAll === true) return { restricted: true, reason: 'restricted_all' }
  if (communicationClass === 'message' && state.denyMessage === true) return { restricted: true, reason: 'restricted_message' }
  if (communicationClass === 'voice' && state.denyVoice === true) return { restricted: true, reason: 'restricted_voice' }
  return { restricted: false, reason: 'no_restriction' }
}

/**
 * The merge composition: deny always wins. The survivor keeps every restriction
 * either side had. Null when neither side had a policy, so a merge of two
 * unrestricted Contacts writes nothing.
 */
export function composeContactCommunicationPolicyV1(
  source: ContactCommunicationRestrictionStateV1 | null,
  survivor: ContactCommunicationRestrictionStateV1 | null,
): ContactCommunicationRestrictionStateV1 | null {
  if (source === null && survivor === null) return null
  return {
    denyAll: source?.denyAll === true || survivor?.denyAll === true,
    denyMessage: source?.denyMessage === true || survivor?.denyMessage === true,
    denyVoice: source?.denyVoice === true || survivor?.denyVoice === true,
  }
}

/**
 * The semantics of one mutation request, as a digest. Two requests with the
 * same requestId are the same request exactly when this is equal; a reused id
 * with any other Contact, version, flags, actor or reason is a conflict.
 */
export function contactCommunicationPolicyRequestDigestV1(
  command: Pick<SetContactCommunicationPolicyCommandV1, 'contactId' | 'expectedVersion' | 'restriction' | 'actor' | 'reason'>,
): string {
  const canonical = JSON.stringify({
    actor: command.actor,
    contactId: command.contactId,
    expectedVersion: command.expectedVersion,
    reason: command.reason,
    restriction: {
      denyAll: command.restriction.denyAll === true,
      denyMessage: command.restriction.denyMessage === true,
      denyVoice: command.restriction.denyVoice === true,
    },
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/** A bounded actor string acceptable to the event store, or the fallback when the candidate is unusable. */
export function contactCommunicationPolicyActorV1(candidate: unknown, fallback: string): string {
  if (typeof candidate !== 'string') return fallback
  const trimmed = candidate.trim()
  if (!trimmed || trimmed.length > 128 || /[\u0000-\u001F\u007F]/u.test(trimmed)) return fallback
  return trimmed
}

function isSnapshotLike(value: unknown): value is ContactCommunicationPolicySnapshotV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.denyAll === 'boolean'
    && typeof record.denyMessage === 'boolean'
    && typeof record.denyVoice === 'boolean'
    && Number.isSafeInteger(record.version)
    && (record.version as number) >= 1
}

export type ContactMergeCommunicationPolicyEvidenceParseV1 =
  | { kind: 'absent' }
  | { kind: 'present'; evidence: ContactMergeCommunicationPolicyEvidenceV1 }
  | { kind: 'malformed' }

/**
 * Reads the policy evidence back from a stored merge snapshot. A merge recorded
 * before this foundation existed carries none (`absent`); a present record must
 * be exactly the three snapshots-or-nulls, consistent with the composition rule,
 * or it is `malformed` and recovery fails closed rather than guessing what the
 * merge did.
 */
export function parseContactMergeCommunicationPolicyEvidenceV1(value: unknown): ContactMergeCommunicationPolicyEvidenceParseV1 {
  if (value === undefined || value === null) return { kind: 'absent' }
  if (typeof value !== 'object' || Array.isArray(value)) return { kind: 'malformed' }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.join(',') !== 'composed,sourceBefore,survivorBefore') return { kind: 'malformed' }
  const snapshot = (candidate: unknown): ContactCommunicationPolicySnapshotV1 | null | undefined => {
    if (candidate === null) return null
    if (!isSnapshotLike(candidate)) return undefined
    return { ...restrictionStateOfV1(candidate), version: candidate.version }
  }
  const sourceBefore = snapshot(record.sourceBefore)
  const survivorBefore = snapshot(record.survivorBefore)
  const composed = snapshot(record.composed)
  if (sourceBefore === undefined || survivorBefore === undefined || composed === undefined) return { kind: 'malformed' }
  // A composed row exists exactly when at least one side had a policy, and it
  // must be the OR of the two sides at the version right after the survivor's.
  if ((composed === null) !== (sourceBefore === null && survivorBefore === null)) return { kind: 'malformed' }
  if (composed !== null) {
    const expected = composeContactCommunicationPolicyV1(sourceBefore, survivorBefore)
    if (!sameRestrictionStateV1(expected, composed)) return { kind: 'malformed' }
    if (composed.version !== (survivorBefore?.version ?? 0) + 1) return { kind: 'malformed' }
  }
  return { kind: 'present', evidence: { sourceBefore, survivorBefore, composed } }
}

// ---------------------------------------------------------------------------
// Automated merge recovery rule
// ---------------------------------------------------------------------------

/** One survivor event written after the merge under recovery, in version order. */
export type ContactCommunicationPolicyRecoveryEventV1 = {
  cause: ContactCommunicationPolicyEventCauseV1
  version: number
  mergeId: string | null
}

export type ContactCommunicationPolicyRecoveryBlockReasonV1 =
  | 'communication_policy_evidence_invalid'
  | 'communication_policy_without_merge_evidence'
  | 'source_policy_changed_after_merge'
  | 'communication_policy_changed_after_merge'

export type ContactCommunicationPolicyRecoveryDecisionV1 =
  | { kind: 'nothing_to_restore' }
  | {
      kind: 'restore'
      /** The survivor row version the restore compares-and-sets against. */
      currentVersion: number
      before: ContactCommunicationRestrictionStateV1
      restoreTo: ContactCommunicationRestrictionStateV1
    }
  | { kind: 'blocked'; reason: ContactCommunicationPolicyRecoveryBlockReasonV1 }

/**
 * Whether reversing one merge may also reverse its policy composition.
 *
 * The survivor's policy must still be the state that merge produced. "Still"
 * is proven from the append-only event chain, not from the version number
 * alone: the only writes allowed after the composition are later merges into
 * the same survivor that have themselves already been reversed, in last-in,
 * first-out order, so that each merge/merge_recovery pair nets to the state the
 * earlier merge produced. One mutation event — an explicit decision taken after
 * the merge — or one later merge that has not been reversed blocks recovery,
 * because reversing would overwrite that newer policy. A merge recorded before
 * this foundation existed carries no evidence; the survivor must then have no
 * policy row at all, since any row necessarily postdates that merge.
 *
 * The merged-away Contact's own row is only cross-checked: recovery never
 * writes it, so it must still be exactly what the merge recorded.
 */
export function decideContactCommunicationPolicyRecoveryV1(input: {
  evidence: ContactMergeCommunicationPolicyEvidenceParseV1
  survivorCurrent: ContactCommunicationPolicySnapshotV1 | null
  sourceCurrent: ContactCommunicationPolicySnapshotV1 | null
  /** Survivor events with a version greater than the composed version, ascending. */
  laterSurvivorEvents: readonly ContactCommunicationPolicyRecoveryEventV1[]
}): ContactCommunicationPolicyRecoveryDecisionV1 {
  const blocked = (reason: ContactCommunicationPolicyRecoveryBlockReasonV1): ContactCommunicationPolicyRecoveryDecisionV1 => ({ kind: 'blocked', reason })
  if (input.evidence.kind === 'malformed') return blocked('communication_policy_evidence_invalid')
  if (input.evidence.kind === 'absent') {
    return input.survivorCurrent === null
      ? { kind: 'nothing_to_restore' }
      : blocked('communication_policy_without_merge_evidence')
  }
  const { evidence } = input.evidence
  if (!sameContactCommunicationPolicySnapshotV1(input.sourceCurrent, evidence.sourceBefore)) {
    return blocked('source_policy_changed_after_merge')
  }
  if (evidence.composed === null) {
    return input.survivorCurrent === null
      ? { kind: 'nothing_to_restore' }
      : blocked('communication_policy_changed_after_merge')
  }
  if (input.survivorCurrent === null) return blocked('communication_policy_changed_after_merge')
  if (!sameRestrictionStateV1(input.survivorCurrent, evidence.composed)) return blocked('communication_policy_changed_after_merge')

  // Every later write must be a merge that was reversed again, LIFO.
  const openMerges: string[] = []
  let version = evidence.composed.version
  for (const event of input.laterSurvivorEvents) {
    if (event.version !== version + 1) return blocked('communication_policy_changed_after_merge')
    version = event.version
    if (event.cause === 'merge') {
      if (event.mergeId === null) return blocked('communication_policy_changed_after_merge')
      openMerges.push(event.mergeId)
      continue
    }
    if (event.cause === 'merge_recovery') {
      if (event.mergeId === null || openMerges.pop() !== event.mergeId) return blocked('communication_policy_changed_after_merge')
      continue
    }
    return blocked('communication_policy_changed_after_merge')
  }
  if (openMerges.length > 0 || input.survivorCurrent.version !== version) return blocked('communication_policy_changed_after_merge')

  return {
    kind: 'restore',
    currentVersion: input.survivorCurrent.version,
    before: restrictionStateOfV1(input.survivorCurrent),
    restoreTo: evidence.survivorBefore === null
      ? { ...CONTACT_COMMUNICATION_NO_RESTRICTION_V1 }
      : restrictionStateOfV1(evidence.survivorBefore),
  }
}

// ---------------------------------------------------------------------------
// Permission query
// ---------------------------------------------------------------------------

export type ContactCommunicationPermissionStateV1 =
  | { kind: 'unknown' }
  | { kind: 'found'; canonicalContactId: string; isArchived: boolean; policy: ContactCommunicationPolicySnapshotV1 | null }

export interface ContactCommunicationPolicyReadPortV1 {
  /**
   * Lineage (through the existing Contact lineage handler) and the canonical
   * Contact's archive flag and policy row, read in ONE consistent snapshot, so a
   * merge or a recovery committing between the two reads cannot produce a
   * transient allow. Lineage errors propagate.
   */
  readPermissionState(requestedContactId: string): Promise<ContactCommunicationPermissionStateV1>
}

const LINEAGE_UNSAFE_ERRORS = new Set(['CONTACT_MERGE_REDIRECT_CYCLE', 'CONTACT_MERGE_REDIRECT_DEPTH_EXCEEDED'])

function isLineageUnsafeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return LINEAGE_UNSAFE_ERRORS.has(message)
}

export function createContactCommunicationPermissionQueryHandlerV1(port: ContactCommunicationPolicyReadPortV1) {
  return async function getContactCommunicationPermissionV1(
    query: unknown,
  ): Promise<ContactCommunicationPermissionResultV1> {
    const parsed = parseContactCommunicationPermissionQueryV1(query)
    const base = {
      contract: CONTACT_COMMUNICATION_PERMISSION_RESULT_V1,
      requestedContactId: parsed.contactId,
      communicationClass: parsed.communicationClass,
    } as const
    const deny = (
      reason: ContactCommunicationPermissionReasonV1,
      retryable: boolean,
      canonicalContactId: string | null = null,
      policyVersion: number | null = null,
    ): ContactCommunicationPermissionResultV1 => ({
      ...base, decision: 'deny', retryable, reason, canonicalContactId, policyVersion,
    })

    // An unknown effect class is refused before any store is touched.
    if (!isContactCommunicationClassV1(parsed.communicationClass)) {
      return deny('unsupported_communication_class', false)
    }
    const communicationClass: ContactCommunicationClassV1 = parsed.communicationClass

    let state: ContactCommunicationPermissionStateV1
    try {
      state = await port.readPermissionState(parsed.contactId)
    } catch (error) {
      // Nothing may be allowed on a lineage or a store that could not be established.
      return deny(isLineageUnsafeError(error) ? 'lineage_unsafe' : 'policy_unavailable', true)
    }
    if (state.kind === 'unknown') return deny('contact_unknown', false)
    const policyVersion = state.policy?.version ?? 0
    // A canonical Contact that is archived without a redirect is not a live
    // person record; nothing may be addressed to it.
    if (state.isArchived) return deny('contact_archived', false, state.canonicalContactId, policyVersion)

    const verdict = evaluateContactCommunicationRestrictionV1(state.policy, communicationClass)
    if (verdict.restricted) return deny(verdict.reason, false, state.canonicalContactId, policyVersion)
    return {
      ...base,
      decision: 'allow',
      retryable: false,
      reason: 'no_restriction',
      canonicalContactId: state.canonicalContactId,
      policyVersion,
    }
  }
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

export type ContactCommunicationPolicyMutationEventV1 = {
  contactId: string
  requestDigest: string
  version: number
  after: ContactCommunicationRestrictionStateV1
}

/**
 * What the mutation may do while it holds the Contact's ownership lock. Every
 * method is bound to the same transaction the adapter admitted through the
 * Contacts ownership coordinator, so nothing here can observe a Contact
 * snapshot a concurrent merge is changing.
 */
export interface ContactCommunicationPolicyLockedScopeV1 {
  /** The existing lineage handler bound to the locked transaction. */
  resolveLineage(requestedContactId: string): Promise<ContactLineageV1 | null>
  readContact(contactId: string): Promise<{ isArchived: boolean } | null>
  findMutationEvent(requestId: string): Promise<ContactCommunicationPolicyMutationEventV1 | null>
  readPolicy(contactId: string): Promise<ContactCommunicationPolicySnapshotV1 | null>
  /** Insert at version 1 when expectedVersion is 0, otherwise a compare-and-set update; must affect exactly one row. */
  writePolicy(input: {
    contactId: string
    expectedVersion: number
    version: number
    restriction: ContactCommunicationRestrictionStateV1
    actor: string
  }): Promise<void>
  appendEvent(input: ContactCommunicationPolicyEventInputV1): Promise<void>
}

export interface ContactCommunicationPolicyMutationPortV1 {
  /** Runs `work` inside the Contacts ownership transaction with the Contact's ownership rows locked. */
  runLocked<T>(contactId: string, work: (scope: ContactCommunicationPolicyLockedScopeV1) => Promise<T>): Promise<T>
}

function lineageUnsafeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (message === 'CONTACT_MERGE_REDIRECT_CYCLE') return 'redirect_cycle'
  if (message === 'CONTACT_MERGE_REDIRECT_DEPTH_EXCEEDED') return 'redirect_depth_exceeded'
  return 'lineage_unavailable'
}

export function createSetContactCommunicationPolicyHandlerV1(port: ContactCommunicationPolicyMutationPortV1) {
  return async function setContactCommunicationPolicyV1(
    command: unknown,
  ): Promise<SetContactCommunicationPolicyResultV1> {
    const parsed = parseSetContactCommunicationPolicyCommandV1(command)
    const requested = restrictionStateOfV1(parsed.restriction)
    const digest = contactCommunicationPolicyRequestDigestV1({ ...parsed, restriction: requested })
    const contract = SET_CONTACT_COMMUNICATION_POLICY_RESULT_V1

    return port.runLocked(parsed.contactId, async scope => {
      // 1. Idempotency is decided first and answered from the event alone: a
      //    retry of an already applied request replays however far the policy
      //    or the Contact's lineage moved since, and never becomes a second
      //    decision somewhere else.
      const previousRequest = await scope.findMutationEvent(parsed.requestId)
      if (previousRequest !== null) {
        if (previousRequest.requestDigest === digest && previousRequest.contactId === parsed.contactId) {
          return { contract, status: 'replayed', contactId: parsed.contactId, version: previousRequest.version, restriction: restrictionStateOfV1(previousRequest.after) }
        }
        return { contract, status: 'idempotency_conflict', contactId: parsed.contactId, requestId: parsed.requestId }
      }

      // 2. The target must be the canonical, live Contact. The same lineage
      //    handler the read uses decides that, on the locked snapshot.
      let lineage: ContactLineageV1 | null
      try {
        lineage = await scope.resolveLineage(parsed.contactId)
      } catch (error) {
        return { contract, status: 'lineage_unsafe', contactId: parsed.contactId, reason: lineageUnsafeReason(error) }
      }
      if (lineage === null) return { contract, status: 'contact_not_found', contactId: parsed.contactId }
      if (lineage.canonicalContactId !== parsed.contactId) {
        return { contract, status: 'contact_not_canonical', contactId: parsed.contactId, canonicalContactId: lineage.canonicalContactId }
      }
      const contact = await scope.readContact(parsed.contactId)
      if (contact === null) return { contract, status: 'contact_not_found', contactId: parsed.contactId }
      if (contact.isArchived) return { contract, status: 'lineage_unsafe', contactId: parsed.contactId, reason: 'archived_without_redirect' }

      // 3. Optimistic version check against the locked row.
      const current = await scope.readPolicy(parsed.contactId)
      const currentVersion = current?.version ?? 0
      if (parsed.expectedVersion !== currentVersion) {
        return { contract, status: 'version_conflict', contactId: parsed.contactId, expectedVersion: parsed.expectedVersion, currentVersion }
      }

      // 4. Write the exact requested state at the next version and record why.
      //    An explicit request that changes nothing still advances the version:
      //    it is a decision, and later merge recovery must be able to see it.
      const version = currentVersion + 1
      await scope.writePolicy({
        contactId: parsed.contactId,
        expectedVersion: currentVersion,
        version,
        restriction: requested,
        actor: parsed.actor,
      })
      await scope.appendEvent({
        contactId: parsed.contactId,
        cause: 'mutation',
        version,
        previousVersion: current === null ? null : current.version,
        before: current === null ? null : restrictionStateOfV1(current),
        after: requested,
        actor: parsed.actor,
        reason: parsed.reason,
        mutationRequestId: parsed.requestId,
        requestDigest: digest,
        mergeId: null,
        sourceContactId: null,
      })
      return { contract, status: 'applied', contactId: parsed.contactId, version, restriction: requested }
    })
  }
}
