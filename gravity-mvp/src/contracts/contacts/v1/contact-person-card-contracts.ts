// contacts.ContactPersonCardQuery.v1 — the Contacts-owned read model behind the
// standalone «Карточка человека» page.
//
// One read-only query for one exact canonical Contact id, answered only to a
// verified server-side principal. It carries what Contacts owns about one person:
// the canonical name, the phones with their evidence state, every channel account
// (active, inactive and conflicted alike) with its stable identifiers, the merge
// lineage, the recorded identity conflicts, the person-confirmation state and the
// Contacts-recorded candidate links. It never carries a Driver row, a park, a
// conversation or any delivery state: those belong to Fleet Operations and
// Messaging and are composed beside this card by the platform shell.
//
// A merged-away id is never answered with data: it is redirected to its canonical
// Contact so the page can follow the lineage, and a client cannot address a person
// by any other key than the exact id.
export const CONTACT_PERSON_CARD_QUERY_V1 = 'contacts.ContactPersonCardQuery.v1' as const
export const CONTACT_PERSON_CARD_RESULT_V1 = 'contacts.ContactPersonCardResult.v1' as const

export type ContactPersonCardQueryV1 = {
  contract: typeof CONTACT_PERSON_CARD_QUERY_V1
  /** The exact Contact id. It is never trimmed, normalized or matched loosely. */
  contactId: string
}

/** Contacts' operator-confirmation state about which physical person this Contact is. */
export type ContactPersonConfirmationStateV1 =
  | 'confirmed'
  | 'needs_reconciliation'
  | 'contradiction'
  | 'unconfirmed'

export type ContactPersonConfirmationV1 = {
  state: ContactPersonConfirmationStateV1
  /** The name proven by the operator's recorded confirmation (confirmedPersonNameV1), or null. */
  confirmedPersonName: string | null
  /** Distinct person-cluster keys with an active confirmation. More than one is itself an open question. */
  confirmedClusterKeyCount: number
  /** The Driver the operator pointed at when confirming, when exactly one confirmation stands. */
  representativeDriverId: string | null
}

export type ContactPersonCardPhoneV1 = {
  phoneId: string
  /** The stored E.164 value; formatting is the presentation's job. */
  phone: string
  isPrimary: boolean
  isActive: boolean
  lifecycle: 'current' | 'superseded' | 'removed' | 'unknown'
  trust: 'provider_bound' | 'manually_verified' | 'source_asserted' | 'claimed' | 'unknown'
  freshness: 'fresh' | 'stale' | 'unknown'
  resolutionState: 'unique' | 'shared' | 'disputed' | 'unknown'
  verifiedAt: string | null
  lastSeenAt: string | null
}

export type ContactPersonCardAccountV1 = {
  identityId: string
  /** The provider's stable account identifier as stored (Telegram user id, WhatsApp jid, MAX user id, …). */
  externalId: string
  displayName: string | null
  username: string | null
  isActive: boolean
  source: 'auto' | 'manual' | 'yandex' | 'unknown'
  origin: string
  conflictState: 'clear' | 'conflicted'
  reachabilityStatus: 'confirmed' | 'unreachable' | 'unknown'
  reachabilityCheckedAt: string | null
  linkedPhoneId: string | null
  aliasCount: number
  createdAt: string
}

export type ContactPersonCardChannelV1 = {
  channel: string
  /** Every account on this channel, active first, then by creation time. Nothing is folded or hidden. */
  accounts: ContactPersonCardAccountV1[]
}

export type ContactPersonCardMergeEventV1 = {
  mergeId: string
  action: 'merge' | 'unmerge'
  reason: string
  mergedBy: string
  createdAt: string
  mergedContactId: string
  survivorContactId: string
}

export type ContactPersonCardLineageV1 = {
  canonicalContactId: string
  /** The canonical id and every id merged into it, sorted. */
  contactIds: string[]
  mergedFromCount: number
  mergeHistory: ContactPersonCardMergeEventV1[]
}

/** One recorded identity conflict, as the Contacts conflict projection reports it. Enums only, never stored free text. */
export type ContactPersonCardConflictV1 = {
  origin: 'journal' | 'identity_latch'
  identityId: string | null
  identityState: 'active' | 'inactive' | 'missing' | 'contact'
  channel: string | null
  conflictClass: string
  scope: 'person' | 'transport_only'
  status: 'open' | 'closed'
  personBlocking: boolean
  otherContactId: string | null
  detectedAt: string | null
}

/** Why Contacts already records another Contact as possibly the same person. Never a UI guess. */
export type ContactPersonCardCandidateBasisV1 =
  | 'needs_reconciliation'
  | 'open_conflict'

export type ContactPersonCardCandidateV1 = {
  contactId: string
  basis: ContactPersonCardCandidateBasisV1
}

export type ContactPersonCardV1 = {
  contactId: string
  displayName: string
  displayTitle: string
  primaryPhone: string | null
  displayNameSource: string
  source: string
  personConfirmation: ContactPersonConfirmationV1
  /** Contacts' legacy main-driver projection; a Fleet row id, not a person fact. */
  mainDriverId: string | null
  /** Contacts' legacy one-driver link, so the composition can ask Fleet for that row too. */
  legacyYandexDriverId: string | null
  phones: ContactPersonCardPhoneV1[]
  channels: ContactPersonCardChannelV1[]
  lineage: ContactPersonCardLineageV1
  conflicts: ContactPersonCardConflictV1[]
  hasOpenConflict: boolean
  hasPersonBlockingConflict: boolean
  candidates: ContactPersonCardCandidateV1[]
  automation: { doNotMerge: boolean; canonicalPinned: boolean; mergeRecoveryState: string | null }
  isArchived: boolean
}

/**
 * confirmed  — the exact Contact is canonical and may be shown to this principal;
 * redirected — the id was merged into another Contact; only the canonical id is named;
 * missing    — no Contact has this id, or it is archived without a lineage to follow;
 * forbidden  — no verified server-side principal, or it may not read this Contact;
 * refused    — the source could not be read consistently or did not name the asked Contact.
 * Only `confirmed` carries data; `redirected` carries exactly one id and nothing else.
 * `confirmed` also carries the ВУ view this principal was granted
 * (ContactReadAuthorityQuery.v1): 'full' or 'last4'. It is a visibility
 * decision, not data; the composition hands it to Fleet unchanged.
 */
export type ContactPersonCardStatusV1 = 'confirmed' | 'redirected' | 'missing' | 'forbidden' | 'refused'

export type ContactPersonCardResultV1 =
  | { contract: typeof CONTACT_PERSON_CARD_RESULT_V1; status: 'confirmed'; card: ContactPersonCardV1; licenceView: 'full' | 'last4' }
  | { contract: typeof CONTACT_PERSON_CARD_RESULT_V1; status: 'redirected'; canonicalContactId: string }
  | { contract: typeof CONTACT_PERSON_CARD_RESULT_V1; status: Exclude<ContactPersonCardStatusV1, 'confirmed' | 'redirected'> }

export class ContactPersonCardValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
  constructor(code: ContactPersonCardValidationError['code'], message: string) {
    super(message)
    this.name = 'ContactPersonCardValidationError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new ContactPersonCardValidationError('INVALID_CONTRACT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseContactPersonCardQueryV1(input: unknown): ContactPersonCardQueryV1 {
  if (!isRecord(input)) invalid('query must be an object')
  const extraFields = Object.keys(input).filter(key => key !== 'contract' && key !== 'contactId')
  if (extraFields.length > 0) invalid(`unsupported field(s): ${extraFields.sort().join(', ')}`)
  if (input.contract !== CONTACT_PERSON_CARD_QUERY_V1) {
    if (typeof input.contract === 'string' && input.contract.startsWith('contacts.ContactPersonCardQuery.')) {
      throw new ContactPersonCardValidationError('UNSUPPORTED_CONTRACT_VERSION', `unsupported contract version: ${input.contract}`)
    }
    invalid(`contract must equal ${CONTACT_PERSON_CARD_QUERY_V1}`)
  }
  if (typeof input.contactId !== 'string' || input.contactId === '' || input.contactId.trim() !== input.contactId) {
    invalid('contactId must be an exact, non-empty Contact id')
  }
  return { contract: CONTACT_PERSON_CARD_QUERY_V1, contactId: input.contactId }
}
