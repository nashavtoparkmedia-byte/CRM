// The production authority of the ContactPersonCardQuery.v1 read model.
//
// As for the CC-1 conversation card, the only principal this repository can
// verify server-side for a CRM read today is Identity Access's signed
// integration-admin session, built after the HMAC session is verified and
// deliberately ignoring crm_user_id (an unsigned UI selector). It administers
// the whole CRM and has no fleet restriction anywhere in the repository, so it
// may read every Contact. This is the engineering/acceptance gate of phase 1:
// an ordinary manager's access arrives with Staff Session v1 as a further
// principal kind admitted here, never by loosening this set from a composition.
import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'
import type { ContactPersonCardAuthorityPortV1, ContactPersonCardPrincipalV1 } from './contact-person-card'

const UNRESTRICTED_PRINCIPAL_KINDS: ReadonlySet<string> = new Set(['integration_admin_session'])

function isUnrestricted(principal: ContactPersonCardPrincipalV1): boolean {
  return UNRESTRICTED_PRINCIPAL_KINDS.has(principal.kind)
}

export const identityAccessContactPersonCardAuthorityV1: ContactPersonCardAuthorityPortV1 = {
  async currentPrincipal() {
    const principal = await getIntegrationAdminPrincipal()
    return principal === null ? null : { kind: principal.kind }
  },
  async mayReadContact(principal) {
    return isUnrestricted(principal)
  },
}
