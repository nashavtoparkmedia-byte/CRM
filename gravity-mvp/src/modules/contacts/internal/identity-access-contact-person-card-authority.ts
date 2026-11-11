// The production authority of the ContactPersonCardQuery.v1 read model.
//
// Its principal is Contacts' own read-authority answer (ContactReadAuthorityQuery.v1,
// D2): a verified Staff Session employee of any reader role or, transitionally
// until Staff Session is enforced in production, the integration-admin session.
// Neither carries a fleet restriction anywhere in the repository, so either may
// read every Contact. crm_user_id, cookies and headers are never read here; the
// ВУ view travels with the principal so the composition hands it to Fleet.
import { resolveContactReadAuthorityFromIdentityAccessV1 } from './identity-access-contact-read-authority'
import type { ContactPersonCardAuthorityPortV1, ContactPersonCardPrincipalV1 } from './contact-person-card'

const READER_PRINCIPAL_KINDS: ReadonlySet<string> = new Set(['staff_session', 'integration_admin_session'])

function isReader(principal: ContactPersonCardPrincipalV1): boolean {
  return READER_PRINCIPAL_KINDS.has(principal.kind)
}

export const identityAccessContactPersonCardAuthorityV1: ContactPersonCardAuthorityPortV1 = {
  async currentPrincipal() {
    const authority = await resolveContactReadAuthorityFromIdentityAccessV1()
    return authority.decision === 'allow'
      ? { kind: authority.principal.kind, licenceView: authority.licenceView }
      : null
  },
  async mayReadContact(principal) {
    return isReader(principal)
  },
}
