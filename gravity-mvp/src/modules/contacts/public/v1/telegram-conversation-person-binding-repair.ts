/**
 * Bounded repair for one Telegram conversation whose person binding is wrong.
 *
 * The production condition this exists for: one real person is represented by two
 * Contacts — a Telegram-only Contact carrying the Telegram identity and
 * conversation, and the yandex-mastered Contact carrying the verified phone and
 * the proven Driver profiles — while the conversation's `Chat.driverId` still
 * names a Driver belonging to a *different* person from an old auto-match. Bot
 * driver actions then fail closed forever, because
 * `prepareDriverTelegramConversationAuthorityV1` requires both an exact Chat
 * driver and a confirmed main Driver on the conversation's Contact.
 *
 * This is NOT a generic merge API. It takes the canonical Contact, the duplicate
 * Contact and the representative Driver as three explicit inputs, re-proves every
 * fact live, and refuses on any mismatch.
 *
 * The survivor is elected by the mechanism the repository already ships for
 * exactly this purpose: the manual canonical pin. `evaluateContactSurvivorV1`
 * compares `manual_canonical_pin` first, so pinning the canonical Contact — and
 * refusing unless the duplicate is unpinned — makes the ordinary merge elect it.
 * No survivor directive is injected into the merge handler and no caller of the
 * public merge surface gains a forced-survivor mechanism: `mergeContactsV1`
 * behind `POST /api/contacts/:sourceId/merge-to/:targetId` is untouched and keeps
 * deciding survivors from observable state, which now simply includes the pin.
 *
 * Ownership: every mutation goes through existing owner primitives — the Contacts
 * canonical pin, the Contacts merge unit of work (which owns `moveOwnedState`,
 * `composeContactState`, `recordMerge` and the Messaging-owned
 * `moveChatsToDriverContact`) and `confirmDriverPersonV1`. This module performs
 * no persistence of its own and holds no Prisma client.
 *
 * Atomicity: the repair is deliberately MULTI PHASE and does not claim otherwise.
 * `pinCanonicalContactV1` and `confirmDriverPersonV1` each open their own
 * `runContactOwnershipTransaction`, and Prisma interactive transactions cannot
 * nest, so the pin, the merge and the confirmation cannot share one transaction.
 * See `RepairPhaseModelV1` below for the intermediate states, each of which is
 * deny-only and safely retryable.
 */

export type RepairTelegramConversationPersonBindingInputV1 = {
  /** The Contact that must survive: the real person of record. */
  canonicalContactId: string
  /** The duplicate Contact that must be merged away. */
  duplicateContactId: string
  /** The Driver that must become the confirmed representative of the person. */
  representativeDriverId: string
  /** Telegram peer id of the conversation being repaired. */
  telegramExternalId: string
  /** Proven integration-admin principal id, used as the merge/confirmation actor. */
  actorId: string
}

export type RepairTelegramConversationPersonBindingResultV1 =
  | {
      status: 'repaired'
      survivorContactId: string
      mergedContactId: string
      chatId: string
      driverId: string
      confirmationId: string | null
    }
  | {
      status: 'already_repaired'
      survivorContactId: string
      chatId: string
      driverId: string
    }
  | {
      /**
       * Phases 1-2 committed, phase 3 did not. The conversation now belongs to
       * the canonical Contact and names the representative Driver, but the
       * Contact has no confirmed main Driver yet, so driver actions still fail
       * closed exactly as they did before the repair. Re-running the repair
       * resumes at phase 3; nothing is half-granted.
       */
      status: 'merged_pending_confirmation'
      survivorContactId: string
      mergedContactId: string
      chatId: string
      driverId: string
      confirmationError: string
    }

/** Every refusal reason. Each one means zero mutation. */
export type RepairRefusalReasonV1 =
  | 'ACTOR_NOT_PROVEN'
  | 'INPUT_INVALID'
  | 'CANONICAL_CONTACT_NOT_FOUND'
  | 'DUPLICATE_CONTACT_NOT_FOUND'
  | 'CANONICAL_CONTACT_ARCHIVED'
  | 'DUPLICATE_CONTACT_ARCHIVED'
  | 'CONTACT_ALREADY_MERGED'
  | 'EXISTING_MERGE_RELATION'
  | 'DUPLICATE_CONTACT_CANONICALLY_PINNED'
  | 'CANONICAL_PIN_FAILED'
  | 'MERGE_FAILED_AFTER_CANONICAL_PIN'
  | 'REPRESENTATIVE_DRIVER_NOT_FOUND'
  | 'REPRESENTATIVE_DRIVER_PHONE_MISMATCH'
  | 'CANONICAL_VERIFIED_PHONE_MISSING'
  | 'TELEGRAM_IDENTITY_NOT_OWNED_BY_DUPLICATE'
  | 'TELEGRAM_CHAT_NOT_OWNED_BY_DUPLICATE'
  | 'TELEGRAM_CHAT_STATE_DRIFT'
  | 'DRIVER_TELEGRAM_STATE_DRIFT'
  | 'FLEET_EVIDENCE_UNAVAILABLE'
  | 'FLEET_EVIDENCE_INCOMPLETE'
  | 'FLEET_CLUSTER_STALE'
  | 'FLEET_CLUSTER_MISSING_REPRESENTATIVE'
  | 'MERGE_DID_NOT_ELECT_CANONICAL'
  | 'MERGE_OUTCOME_UNEXPECTED'

export class RepairTelegramConversationPersonBindingRefusalV1 extends Error {
  readonly reason: RepairRefusalReasonV1

  constructor(reason: RepairRefusalReasonV1, message: string) {
    super(message)
    this.name = 'RepairTelegramConversationPersonBindingRefusalV1'
    this.reason = reason
  }
}

/** Live facts the repair re-reads. Supplied by composition; no Prisma here. */
export type RepairPreconditionStateV1 = {
  canonicalContact: {
    id: string
    isArchived: boolean
    mergedIntoContactId: string | null
    yandexDriverId: string | null
    verifiedPrimaryPhoneDigits: string | null
    /** ISO timestamp of an existing manual canonical pin, or null. */
    canonicalPinnedAt: string | null
  } | null
  duplicateContact: {
    id: string
    isArchived: boolean
    mergedIntoContactId: string | null
    /** Must be null: a pinned duplicate would tie the survivor election. */
    canonicalPinnedAt: string | null
  } | null
  representativeDriver: {
    id: string
    phoneDigits: string | null
  } | null
  telegramIdentity: {
    id: string
    contactId: string
    channel: string
    externalId: string
    isActive: boolean
  } | null
  telegramChat: {
    id: string
    channel: string
    chatType: string | null
    externalChatId: string
    contactId: string | null
    contactIdentityId: string | null
    driverId: string | null
  } | null
  driverTelegram: {
    driverId: string | null
    activeParkId: string | null
    phoneVerified: boolean
  } | null
  /** True when a completed merge ledger row already relates the two Contacts. */
  hasMergeRelation: boolean
}

export type RepairFleetClusterProfileV1 = {
  driverId: string | null
  sourceFreshness: string | null
  /** The rest of the authoritative Fleet profile, forwarded verbatim. */
  [key: string]: unknown
}

export type RepairFleetEvidenceV1 = {
  checkedParks: number
  errors: unknown[]
  /** Optional, matching the Fleet search result. Absence is treated as no evidence. */
  clusters?: Array<{
    profileClusterKey: string
    profiles: RepairFleetClusterProfileV1[]
    warnings?: string[]
  }>
}

export type RepairTelegramConversationPersonBindingDependenciesV1 = {
  /** Re-reads every mutable precondition. Called before phase 1 and for idempotency. */
  readState: (input: {
    canonicalContactId: string
    duplicateContactId: string
    representativeDriverId: string
    telegramExternalId: string
  }) => Promise<RepairPreconditionStateV1>
  /** Fleet-owned live search. Called before any DB mutation. */
  readFleetEvidence: (query: string) => Promise<RepairFleetEvidenceV1>
  /**
   * Contacts-owned manual canonical pin. Phase 1. Idempotent, and deny-only: it
   * grants no authority, it only decides who survives the merge that follows.
   */
  pinCanonicalContact: (input: {
    contactId: string
    actorId: string
  }) => Promise<{ status: string }>
  /**
   * The ordinary Contacts merge handler. Phase 2. The survivor is decided by the
   * unchanged heuristic, which the canonical pin from phase 1 now settles.
   */
  mergeDuplicateIntoCanonical: (input: {
    duplicateContactId: string
    canonicalContactId: string
    actorId: string
  }) => Promise<{ status: string; survivorId?: string; mergedId?: string }>
  /** Existing confirmation capability. Phase 3. Never reimplemented here. */
  confirmRepresentativeDriver: (input: {
    contactId: string
    profileClusterKey: string
    representativeDriverId: string
    actorId: string
    searchInput: string
    /**
     * Forwarded verbatim from the cluster this repair already validated.
     * ConfirmDriverPersonCommand.v1 requires non-empty, all-fresh profiles whose
     * cluster key matches and which contain the representative Driver, so an
     * empty snapshot would be refused.
     */
    evidenceProfiles: RepairFleetClusterProfileV1[]
    evidenceWarnings: string[]
  }) => Promise<{ status: string; confirmationId?: string }>
  /** Already-confirmed check, so a re-run is a no-op rather than a second write. */
  isContactConfirmedMainDriver: (contactId: string, driverId: string) => Promise<boolean>
  log?: (message: string) => void
}

function digitsOnly(value: string | null | undefined): string {
  return typeof value === 'string' ? value.replace(/[^0-9]/g, '') : ''
}

function exactId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() === value && value.length > 0 ? value : null
}

function refuse(reason: RepairRefusalReasonV1, message: string): never {
  throw new RepairTelegramConversationPersonBindingRefusalV1(reason, message)
}

/**
 * Phase model, stated explicitly because this repair is not atomic.
 *
 * phase 1 — pin the canonical Contact.
 *   Commits: `customFields.canonicalPinnedAt` + `canonicalPinnedBy` on the
 *   canonical Contact only.
 *   Intermediate state if the process stops here: nothing about the conversation
 *   or any authority has changed. The pin is deny-only — it grants no driver
 *   action, no confirmation and no merge — and its only effect is that a future
 *   merge of this Contact elects it as survivor, which is precisely the operator
 *   decision being recorded. It also marks the Contact's display name as
 *   manually curated, by the existing display policy.
 *   Retry: `pinCanonicalContactV1` preserves an existing pin and reports
 *   `already_pinned`, so a repeat is not a second write.
 *
 * phase 2 — merge duplicate -> canonical through the ordinary merge handler.
 *   Commits: duplicate archived + merge ledger row; Telegram identity moved to
 *   canonical; Telegram Chat repointed to canonical and to the representative
 *   Driver (through the Messaging-owned primitive the merge already uses).
 *   Intermediate state if the process stops here: the conversation is correct,
 *   but the canonical Contact still has no confirmed main Driver, so
 *   `prepareDriverTelegramConversationAuthorityV1` refuses exactly as it did
 *   before the repair. Deny-only: no authority is granted by phases 1-2 alone.
 *   Retry: re-running the repair observes the merge relation and resumes at
 *   phase 3.
 *
 * phase 3 — confirm the representative Driver on the canonical Contact.
 *   Commits: mainDriverId, mainDriverSelection='manual', driverConfirmations.
 *   Retry: `confirmDriverPersonV1` preserves an existing confirmed record and
 *   reports `already_confirmed`, so a repeat is not a second write.
 *
 * There is no ordering in which a partially applied repair grants authority it
 * should not have, because authority needs the merge AND the confirmation.
 *
 * One refusal reason is not zero-mutation: `MERGE_FAILED_AFTER_CANONICAL_PIN`
 * means phase 1 committed and phase 2 did not. Every other refusal is raised
 * before any write.
 */
export type RepairPhaseModelV1 = 'pin_then_merge_then_confirm'

export const REPAIR_PHASE_MODEL_V1: RepairPhaseModelV1 = 'pin_then_merge_then_confirm'

export function createRepairTelegramConversationPersonBindingV1(
  dependencies: RepairTelegramConversationPersonBindingDependenciesV1,
) {
  const log = dependencies.log ?? (() => {})

  return async function repairTelegramConversationPersonBindingV1(
    input: RepairTelegramConversationPersonBindingInputV1,
  ): Promise<RepairTelegramConversationPersonBindingResultV1> {
    const canonicalContactId = exactId(input?.canonicalContactId)
    const duplicateContactId = exactId(input?.duplicateContactId)
    const representativeDriverId = exactId(input?.representativeDriverId)
    const telegramExternalId = exactId(input?.telegramExternalId)
    const actorId = exactId(input?.actorId)

    if (!actorId) refuse('ACTOR_NOT_PROVEN', 'A proven integration-admin actor id is required')
    if (!canonicalContactId || !duplicateContactId || !representativeDriverId || !telegramExternalId) {
      refuse('INPUT_INVALID', 'canonical, duplicate, representative driver and telegram id are all required')
    }
    if (canonicalContactId === duplicateContactId) {
      refuse('INPUT_INVALID', 'canonical and duplicate Contact must differ')
    }
    if (!/^\d+$/.test(telegramExternalId)) {
      refuse('INPUT_INVALID', 'telegramExternalId must be a bare Telegram peer id')
    }

    const state = await dependencies.readState({
      canonicalContactId,
      duplicateContactId,
      representativeDriverId,
      telegramExternalId,
    })

    // ── idempotency: a completed repair is a no-op, never a second mutation ──
    if (state.hasMergeRelation) {
      const chat = state.telegramChat
      if (
        chat
        && chat.contactId === canonicalContactId
        && chat.driverId === representativeDriverId
        && await dependencies.isContactConfirmedMainDriver(canonicalContactId, representativeDriverId)
      ) {
        log('[repair] already repaired; no mutation')
        return {
          status: 'already_repaired',
          survivorContactId: canonicalContactId,
          chatId: chat.id,
          driverId: representativeDriverId,
        }
      }
      // A merge relation exists but the end state is incomplete: resume at phase
      // 3 rather than attempting a second pin or a second merge.
      if (chat && chat.contactId === canonicalContactId && chat.driverId === representativeDriverId) {
        return await runConfirmation({
          dependencies,
          state,
          canonicalContactId,
          duplicateContactId,
          representativeDriverId,
          telegramExternalId,
          actorId,
          chatId: chat.id,
          log,
        })
      }
      refuse(
        'EXISTING_MERGE_RELATION',
        'A merge relation already exists for this pair but the end state does not match the repair target',
      )
    }

    // ── state preconditions ─────────────────────────────────────────────────
    if (!state.canonicalContact) refuse('CANONICAL_CONTACT_NOT_FOUND', `Contact ${canonicalContactId} not found`)
    if (!state.duplicateContact) refuse('DUPLICATE_CONTACT_NOT_FOUND', `Contact ${duplicateContactId} not found`)
    if (state.canonicalContact.isArchived) {
      refuse('CANONICAL_CONTACT_ARCHIVED', `Canonical Contact ${canonicalContactId} is archived`)
    }
    if (state.duplicateContact.isArchived) {
      refuse('DUPLICATE_CONTACT_ARCHIVED', `Duplicate Contact ${duplicateContactId} is archived`)
    }
    if (state.canonicalContact.mergedIntoContactId || state.duplicateContact.mergedIntoContactId) {
      refuse('CONTACT_ALREADY_MERGED', 'One of the Contacts already redirects into another Contact')
    }
    // The survivor election is decided by `manual_canonical_pin`, which compares
    // the two pins first. A pinned duplicate would tie that comparison and let a
    // later reason decide, so the repair refuses instead of guessing.
    if (state.duplicateContact.canonicalPinnedAt) {
      refuse(
        'DUPLICATE_CONTACT_CANONICALLY_PINNED',
        'The duplicate Contact carries a manual canonical pin; resolve the contradiction first',
      )
    }

    // ── one-person proof: representative Driver phone == canonical verified phone
    if (!state.representativeDriver) {
      refuse('REPRESENTATIVE_DRIVER_NOT_FOUND', `Driver ${representativeDriverId} not found`)
    }
    const canonicalPhone = digitsOnly(state.canonicalContact.verifiedPrimaryPhoneDigits)
    if (!canonicalPhone) {
      refuse(
        'CANONICAL_VERIFIED_PHONE_MISSING',
        'The canonical Contact has no verified primary phone to prove the person with',
      )
    }
    if (digitsOnly(state.representativeDriver.phoneDigits) !== canonicalPhone) {
      refuse(
        'REPRESENTATIVE_DRIVER_PHONE_MISMATCH',
        'The representative Driver phone does not match the canonical verified phone',
      )
    }

    // ── the duplicate must own the exact identity and the exact conversation ──
    const identity = state.telegramIdentity
    if (
      !identity
      || identity.contactId !== duplicateContactId
      || identity.channel !== 'telegram'
      || identity.externalId !== telegramExternalId
      || !identity.isActive
    ) {
      refuse(
        'TELEGRAM_IDENTITY_NOT_OWNED_BY_DUPLICATE',
        'The Telegram identity is not an active identity of the duplicate Contact',
      )
    }
    const chat = state.telegramChat
    if (!chat || chat.contactId !== duplicateContactId) {
      refuse(
        'TELEGRAM_CHAT_NOT_OWNED_BY_DUPLICATE',
        'The Telegram conversation is not owned by the duplicate Contact',
      )
    }
    if (
      chat.channel !== 'telegram'
      || chat.chatType !== 'private'
      || chat.externalChatId !== `telegram:${telegramExternalId}`
      || chat.contactIdentityId !== identity.id
    ) {
      refuse('TELEGRAM_CHAT_STATE_DRIFT', 'The Telegram conversation before-state does not match expectations')
    }
    // The conversation must currently name some other Driver: that is the defect
    // being repaired. If it already names the representative Driver there is
    // nothing for phase 1 to move.
    if (chat.driverId === representativeDriverId) {
      refuse(
        'TELEGRAM_CHAT_STATE_DRIFT',
        'The conversation already names the representative Driver; no binding repair is required',
      )
    }

    // ── the Telegram runtime binding must already agree with the target ──────
    if (!state.driverTelegram || state.driverTelegram.driverId !== representativeDriverId) {
      refuse(
        'DRIVER_TELEGRAM_STATE_DRIFT',
        'DriverTelegram does not already point at the representative Driver; this repair does not move it',
      )
    }

    // ── Fleet evidence, obtained BEFORE any DB mutation ─────────────────────
    const fleetQuery = canonicalPhone
    let fleet: RepairFleetEvidenceV1
    try {
      fleet = await dependencies.readFleetEvidence(fleetQuery)
    } catch (error) {
      refuse(
        'FLEET_EVIDENCE_UNAVAILABLE',
        `Fresh Fleet evidence is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!fleet || fleet.checkedParks <= 0 || (fleet.errors?.length ?? 0) > 0) {
      refuse('FLEET_EVIDENCE_INCOMPLETE', 'Fresh complete Fleet evidence is required')
    }
    const clusters = (fleet.clusters ?? []).filter(cluster => (
      cluster.profiles.some(profile => profile.driverId === representativeDriverId)
    ))
    if (clusters.length !== 1) {
      refuse(
        'FLEET_CLUSTER_MISSING_REPRESENTATIVE',
        'Fleet evidence does not contain exactly one cluster holding the representative Driver',
      )
    }
    const [cluster] = clusters
    if (cluster.profiles.length === 0 || cluster.profiles.some(profile => profile.sourceFreshness !== 'fresh')) {
      refuse('FLEET_CLUSTER_STALE', 'The Fleet cluster is stale; search again')
    }

    // ── phase 1: pin the canonical Contact, so the merge elects it ──────────
    log(`[repair] phase 1: pinning canonical Contact ${canonicalContactId}`)
    try {
      await dependencies.pinCanonicalContact({ contactId: canonicalContactId, actorId })
    } catch (error) {
      refuse(
        'CANONICAL_PIN_FAILED',
        `The canonical pin did not commit: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    // ── phase 2: the ordinary merge; the pin decides the survivor ───────────
    log(`[repair] phase 2: merging ${duplicateContactId} into ${canonicalContactId}`)
    let merge: { status: string; survivorId?: string; mergedId?: string }
    try {
      merge = await dependencies.mergeDuplicateIntoCanonical({
        duplicateContactId,
        canonicalContactId,
        actorId,
      })
    } catch (error) {
      // The pin is committed and the merge is not. Deny-only and retryable, but
      // it is NOT zero mutation, so it gets its own reason rather than being
      // reported as an ordinary precondition failure.
      refuse(
        'MERGE_FAILED_AFTER_CANONICAL_PIN',
        `The canonical pin committed but the merge did not: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    // `contact_to_contact` reports success as `contact_merged`; `merged` belongs
    // to the retired contact-to-driver operation and must never appear here.
    if (merge.status !== 'contact_merged') {
      refuse('MERGE_OUTCOME_UNEXPECTED', `Merge returned unexpected status ${merge.status}`)
    }
    // The canonical pin should have settled `manual_canonical_pin` in the
    // survivor heuristic. This is the safety net that proves it did, and it fires
    // before any confirmation is attempted.
    if (merge.survivorId !== canonicalContactId || merge.mergedId !== duplicateContactId) {
      refuse(
        'MERGE_DID_NOT_ELECT_CANONICAL',
        `Merge elected survivor ${merge.survivorId ?? 'unknown'}, expected ${canonicalContactId}`,
      )
    }

    // ── phase 3: confirm the representative Driver on the survivor ──────────
    return await runConfirmation({
      dependencies,
      state,
      canonicalContactId,
      duplicateContactId,
      representativeDriverId,
      telegramExternalId,
      actorId,
      chatId: chat.id,
      profileClusterKey: cluster.profileClusterKey,
      searchInput: fleetQuery,
      evidenceProfiles: cluster.profiles,
      evidenceWarnings: cluster.warnings ?? [],
      log,
    })
  }
}

async function runConfirmation(args: {
  dependencies: RepairTelegramConversationPersonBindingDependenciesV1
  state: RepairPreconditionStateV1
  canonicalContactId: string
  duplicateContactId: string
  representativeDriverId: string
  telegramExternalId: string
  actorId: string
  chatId: string
  profileClusterKey?: string
  searchInput?: string
  evidenceProfiles?: RepairFleetClusterProfileV1[]
  evidenceWarnings?: string[]
  log: (message: string) => void
}): Promise<RepairTelegramConversationPersonBindingResultV1> {
  const {
    dependencies, canonicalContactId, duplicateContactId, representativeDriverId,
    actorId, chatId, log,
  } = args

  // Resuming after phase 2 needs the cluster key again; re-derive it from live
  // Fleet evidence rather than trusting anything cached.
  let profileClusterKey = args.profileClusterKey
  let searchInput = args.searchInput
  let evidenceProfiles = args.evidenceProfiles
  let evidenceWarnings = args.evidenceWarnings
  if (!profileClusterKey || !searchInput || !evidenceProfiles) {
    const phone = digitsOnly(args.state.canonicalContact?.verifiedPrimaryPhoneDigits ?? null)
    if (!phone) {
      refuse('CANONICAL_VERIFIED_PHONE_MISSING', 'Cannot resume: the canonical Contact has no verified phone')
    }
    let fleet: RepairFleetEvidenceV1
    try {
      fleet = await dependencies.readFleetEvidence(phone)
    } catch (error) {
      refuse(
        'FLEET_EVIDENCE_UNAVAILABLE',
        `Fresh Fleet evidence is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!fleet || fleet.checkedParks <= 0 || (fleet.errors?.length ?? 0) > 0) {
      refuse('FLEET_EVIDENCE_INCOMPLETE', 'Fresh complete Fleet evidence is required')
    }
    const matching = (fleet.clusters ?? []).filter(cluster => (
      cluster.profiles.some(profile => profile.driverId === representativeDriverId)
    ))
    if (matching.length !== 1) {
      refuse('FLEET_CLUSTER_MISSING_REPRESENTATIVE', 'Fleet evidence no longer names the representative Driver once')
    }
    if (matching[0].profiles.some(profile => profile.sourceFreshness !== 'fresh')) {
      refuse('FLEET_CLUSTER_STALE', 'The Fleet cluster is stale; search again')
    }
    profileClusterKey = matching[0].profileClusterKey
    searchInput = phone
    evidenceProfiles = matching[0].profiles
    evidenceWarnings = matching[0].warnings ?? []
  }

  if (await dependencies.isContactConfirmedMainDriver(canonicalContactId, representativeDriverId)) {
    log('[repair] representative Driver already confirmed; skipping phase 2')
    return {
      status: 'already_repaired',
      survivorContactId: canonicalContactId,
      chatId,
      driverId: representativeDriverId,
    }
  }

  log(`[repair] phase 3: confirming ${representativeDriverId} on ${canonicalContactId}`)
  try {
    const confirmation = await dependencies.confirmRepresentativeDriver({
      contactId: canonicalContactId,
      profileClusterKey,
      representativeDriverId,
      actorId,
      searchInput,
      evidenceProfiles,
      evidenceWarnings: evidenceWarnings ?? [],
    })
    if (confirmation.status !== 'confirmed' && confirmation.status !== 'already_confirmed') {
      return {
        status: 'merged_pending_confirmation',
        survivorContactId: canonicalContactId,
        mergedContactId: duplicateContactId,
        chatId,
        driverId: representativeDriverId,
        confirmationError: `confirmation returned ${confirmation.status}`,
      }
    }
    return {
      status: 'repaired',
      survivorContactId: canonicalContactId,
      mergedContactId: duplicateContactId,
      chatId,
      driverId: representativeDriverId,
      confirmationId: confirmation.confirmationId ?? null,
    }
  } catch (error) {
    return {
      status: 'merged_pending_confirmation',
      survivorContactId: canonicalContactId,
      mergedContactId: duplicateContactId,
      chatId,
      driverId: representativeDriverId,
      confirmationError: error instanceof Error ? error.message : String(error),
    }
  }
}
