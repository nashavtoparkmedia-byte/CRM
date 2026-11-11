// The production feed of ContactWriteAuthorityQuery.v1: the Identity Access
// facts of this request, read in the order the decision needs them — exactly
// the read authority's order. With a staff cookie present only Staff Session is
// read, so an integration-admin cookie can never stand in for an employee. A
// mobile session is never a writer: Identity Access answers no staff principal
// for it, and it is not an integration-admin session. Nothing client-held is an
// input.
import { getIntegrationAdminPrincipal, getStaffSessionPrincipalV1 } from '@/modules/identity-access/public/v1'
import {
  hasStaffSessionCookieV1,
  isStaffSessionEnforcedForRequestV1,
} from '@/modules/identity-access/public/v1/staff-session'

import {
  decideContactWriteAuthorityV1,
  type ContactWriteAuthorityV1,
} from '../public/v1/contact-write-authority'

export async function resolveContactWriteAuthorityFromIdentityAccessV1(): Promise<ContactWriteAuthorityV1> {
  if (await hasStaffSessionCookieV1()) {
    const staff = await getStaffSessionPrincipalV1()
    return decideContactWriteAuthorityV1({
      staffCookie: 'present',
      staffPrincipal: staff === null ? null : { userId: staff.userId, role: staff.role },
    })
  }
  if (isStaffSessionEnforcedForRequestV1()) {
    return decideContactWriteAuthorityV1({ staffCookie: 'absent', staffSessionEnforced: true, integrationAdminVerified: false })
  }
  const admin = await getIntegrationAdminPrincipal()
  return decideContactWriteAuthorityV1({
    staffCookie: 'absent',
    staffSessionEnforced: false,
    integrationAdminVerified: admin !== null,
  })
}
