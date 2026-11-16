// contacts.ContactIdentityMembershipQuery.v1: the states of exact accounts for
// one person (see the contract). Pure over its port; the port reads one
// consistent snapshot.
import {
  CONTACT_IDENTITY_MEMBERSHIP_RESULT_V1,
  parseContactIdentityMembershipQueryV1,
  type ContactIdentityMembershipResultV1,
  type ContactIdentityMembershipStateV1,
} from '@/contracts/contacts/v1'

export type ContactIdentityMembershipRowV1 = { id: string; contactId: string; isActive: boolean; conflicted: boolean }

export interface ContactIdentityMembershipSourcePortV1 {
  /**
   * The canonical Contact of the asked id (its merge lineage followed) when it is
   * live, and the asked accounts that exist, in one snapshot. Lineage errors propagate.
   */
  read(contactId: string, identityIds: readonly string[]): Promise<{ canonicalContactId: string; rows: ContactIdentityMembershipRowV1[] } | null>
}

function stateOf(row: ContactIdentityMembershipRowV1 | undefined, canonicalContactId: string): ContactIdentityMembershipStateV1 {
  if (row === undefined) return 'missing'
  if (row.contactId !== canonicalContactId) return 'other_contact'
  if (!row.isActive) return 'inactive'
  return row.conflicted ? 'conflicted' : 'active'
}

export function createContactIdentityMembershipHandlerV1(port: ContactIdentityMembershipSourcePortV1) {
  return async function readContactIdentityMembershipV1(query: unknown): Promise<ContactIdentityMembershipResultV1> {
    const parsed = parseContactIdentityMembershipQueryV1(query)
    const snapshot = await port.read(parsed.contactId, parsed.identityIds)
    if (snapshot === null) return { contract: CONTACT_IDENTITY_MEMBERSHIP_RESULT_V1, status: 'not_found' }
    const byId = new Map(snapshot.rows.map(row => [row.id, row]))
    return {
      contract: CONTACT_IDENTITY_MEMBERSHIP_RESULT_V1,
      status: 'found',
      canonicalContactId: snapshot.canonicalContactId,
      identities: parsed.identityIds.map(identityId => ({ identityId, state: stateOf(byId.get(identityId), snapshot.canonicalContactId) })),
    }
  }
}
