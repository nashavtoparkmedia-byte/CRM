// contacts.ContactIdentityMembershipQuery.v1 — whether exact channel accounts
// belong to one person, for Messaging's «Для связи» preference (Contact
// Identity V2; MSR contract 2026-11-17). Messaging never reads ContactIdentity
// itself; it asks Contacts with ids and gets states back.
//
// Read-only and ids-only: no phone, no provider externalId, no name. The asked
// Contact is followed through its merge lineage to the canonical one; an
// account belongs only when it is that canonical Contact's.
export const CONTACT_IDENTITY_MEMBERSHIP_QUERY_V1 = 'contacts.ContactIdentityMembershipQuery.v1' as const
export const CONTACT_IDENTITY_MEMBERSHIP_RESULT_V1 = 'contacts.ContactIdentityMembershipResult.v1' as const
export const CONTACT_IDENTITY_MEMBERSHIP_MAX_IDS_V1 = 25

/**
 * - active: the canonical Contact's, active and without an open identity conflict;
 * - inactive: the canonical Contact's, but deactivated;
 * - conflicted: the canonical Contact's, active, but its evidence carries an open identity conflict;
 * - other_contact: an account of another Contact;
 * - missing: no account with that id.
 */
export const CONTACT_IDENTITY_MEMBERSHIP_STATES_V1 = ['active', 'inactive', 'conflicted', 'other_contact', 'missing'] as const
export type ContactIdentityMembershipStateV1 = typeof CONTACT_IDENTITY_MEMBERSHIP_STATES_V1[number]

export type ContactIdentityMembershipQueryV1 = {
  contract: typeof CONTACT_IDENTITY_MEMBERSHIP_QUERY_V1
  contactId: string
  /** 1..25 distinct exact account ids. */
  identityIds: string[]
}

export type ContactIdentityMembershipResultV1 =
  | {
      contract: typeof CONTACT_IDENTITY_MEMBERSHIP_RESULT_V1
      status: 'found'
      canonicalContactId: string
      /** In the order asked. */
      identities: Array<{ identityId: string; state: ContactIdentityMembershipStateV1 }>
    }
  /** No Contact with that id, or an archived one without a redirect. */
  | { contract: typeof CONTACT_IDENTITY_MEMBERSHIP_RESULT_V1; status: 'not_found' }

export class ContactIdentityMembershipQueryValidationError extends Error {
  readonly code = 'INVALID_CONTRACT' as const
  constructor(message: string) {
    super(message)
    this.name = 'ContactIdentityMembershipQueryValidationError'
  }
}

function invalid(message: string): never {
  throw new ContactIdentityMembershipQueryValidationError(message)
}

function exactId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || value.trim() !== value) invalid(`${field} must be an exact id`)
  return value
}

export function parseContactIdentityMembershipQueryV1(input: unknown): ContactIdentityMembershipQueryV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('query must be an object')
  const value = input as Record<string, unknown>
  const extra = Object.keys(value).filter(key => !['contract', 'contactId', 'identityIds'].includes(key))
  if (extra.length > 0) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)
  if (value.contract !== CONTACT_IDENTITY_MEMBERSHIP_QUERY_V1) invalid(`contract must equal ${CONTACT_IDENTITY_MEMBERSHIP_QUERY_V1}`)
  if (!Array.isArray(value.identityIds) || value.identityIds.length < 1 || value.identityIds.length > CONTACT_IDENTITY_MEMBERSHIP_MAX_IDS_V1) {
    invalid(`identityIds must hold 1..${CONTACT_IDENTITY_MEMBERSHIP_MAX_IDS_V1} ids`)
  }
  const identityIds = value.identityIds.map((id, index) => exactId(id, `identityIds[${index}]`))
  if (new Set(identityIds).size !== identityIds.length) invalid('identityIds must be distinct')
  return { contract: CONTACT_IDENTITY_MEMBERSHIP_QUERY_V1, contactId: exactId(value.contactId, 'contactId'), identityIds }
}
