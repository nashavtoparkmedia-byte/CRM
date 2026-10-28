// The production authority of the CC-1 Contact Card read model.
//
// The only principal this repository can verify server-side for a CRM read
// today is Identity Access's signed integration-admin session. Its principal is
// built after the HMAC session is verified and deliberately ignores crm_user_id,
// which is an unsigned UI identity selector, not authentication. That principal
// administers the whole CRM and has no fleet restriction anywhere in the
// repository, so it may read every conversation and Contact.
//
// No other principal kind is accepted: the browser lane has no verified
// operator (crm_user_id is unsigned), and neither Chat nor Contact carries any
// fleet or tenant attribution against which a narrower principal could be
// checked. Until Identity Access offers such a principal and that attribution
// exists, every other caller is answered `forbidden`.

import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'

import type { ContactCardAuthorityPortV1, ContactCardPrincipalV1 } from './contact-card-for-conversation'

const UNRESTRICTED_PRINCIPAL_KINDS: ReadonlySet<string> = new Set(['integration_admin_session'])

function isUnrestricted(principal: ContactCardPrincipalV1): boolean {
  return UNRESTRICTED_PRINCIPAL_KINDS.has(principal.kind)
}

export const identityAccessContactCardAuthorityV1: ContactCardAuthorityPortV1 = {
  async currentPrincipal() {
    const principal = await getIntegrationAdminPrincipal()
    return principal === null ? null : { kind: principal.kind }
  },
  async mayReadConversation(principal) {
    return isUnrestricted(principal)
  },
  async mayReadContact(principal) {
    return isUnrestricted(principal)
  },
}
