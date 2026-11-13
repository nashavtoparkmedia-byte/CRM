// The production feed of ContactReadAuthorityQuery.v1: the Identity Access
// facts of this request, read in the order the decision needs them.
//
// With a staff cookie present only Staff Session is read: the integration-admin
// session is never consulted, so its cookie cannot raise a staff user's view.
// Only without a staff cookie are the enforcement switch and then the
// transitional integration-admin session read. Nothing client-held is an input:
// crm_user_id, headers, bodies and query parameters are not read here at all.
import { getIntegrationAdminPrincipal, getStaffSessionPrincipalV1 } from '@/modules/identity-access/public/v1'
import {
  hasStaffSessionCookieV1,
  isStaffSessionEnforcedForRequestV1,
} from '@/modules/identity-access/public/v1/staff-session'

import {
  decideContactReadAuthorityV1,
  type ContactReadAuthorityV1,
} from '../public/v1/contact-read-authority'

export async function resolveContactReadAuthorityFromIdentityAccessV1(): Promise<ContactReadAuthorityV1> {
  if (await hasStaffSessionCookieV1()) {
    const staff = await getStaffSessionPrincipalV1()
    return decideContactReadAuthorityV1({
      staffCookie: 'present',
      staffPrincipal: staff === null ? null : { userId: staff.userId, role: staff.role },
    })
  }
  if (isStaffSessionEnforcedForRequestV1()) {
    return decideContactReadAuthorityV1({ staffCookie: 'absent', staffSessionEnforced: true, integrationAdminVerified: false })
  }
  const admin = await getIntegrationAdminPrincipal()
  return decideContactReadAuthorityV1({
    staffCookie: 'absent',
    staffSessionEnforced: false,
    integrationAdminVerified: admin !== null,
  })
}
