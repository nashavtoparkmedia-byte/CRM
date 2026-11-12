// contacts.ContactReadAuthorityQuery.v1 — who may read a person's data, and how
// much of the driving licence (ВУ) they may see.
//
// Contacts owns this decision (Owner D2, OD-03): Identity Access says who the
// employee is and their role; Contacts says whether that principal may read
// people and which ВУ view applies; Fleet shows the ВУ by that view. Callers
// evaluate the answer once per request and pass `licenceView` on; nobody derives
// it from `role` or writes it as a literal.
//
// ВУ view (Owner decision 2026-11-11 ~10:20, on the brute-force risk of a
// last-4 view next to the exact-ВУ search): every verified staff reader role
// sees the full ВУ — «Оставить как есть и принять риск … Полный доступ всем».
// What protects the data is the personal sign-in itself: without a verified
// session nothing is shown. The 'last4' view stays in the contract (Fleet's
// mask still honours it) but this decision no longer answers it.
//
// The resolution is fail-closed and never elevates (docs/design/
// d2-contacts-read-authority-v1.md §3):
// 1. A staff session cookie decides alone. A verified employee is allowed with
//    their registry role; a cookie that does not verify is denied. The
//    integration-admin session is not consulted, so it cannot raise a staff
//    user's view.
// 2. Without a staff cookie and with Staff Session enforced (the production
//    activation switch), the transitional admin read is off.
// 3. Without a staff cookie and without enforcement, a verified
//    integration-admin session is allowed as the TRANSITIONAL path with the full
//    view, until Staff Session is active in production.
//
// This module is pure: the Identity Access reads that feed it live in
// internal/identity-access-contact-read-authority.ts.

export const CONTACT_READ_AUTHORITY_QUERY_V1 = 'contacts.ContactReadAuthorityQuery.v1' as const
export const CONTACT_READ_AUTHORITY_POLICY_VERSION_V1 = 'contacts.read-authority.v1' as const

export const CONTACT_READER_ROLES_V1 = ['Администратор', 'Руководитель', 'Менеджер'] as const
export type ContactReaderRoleV1 = typeof CONTACT_READER_ROLES_V1[number]

/** 'full' shows the stored ВУ; 'last4' shows only its last four characters. */
export type ContactLicenceViewV1 = 'full' | 'last4'

export type ContactReaderPrincipalV1 =
  | { kind: 'staff_session'; userId: string; role: ContactReaderRoleV1 }
  /** Transitional: ends when Staff Session is enforced in production. */
  | { kind: 'integration_admin_session'; transitional: true }

export type ContactReadAuthorityDenialV1 = 'no_session' | 'staff_session_refused' | 'transitional_admin_read_disabled'

export type ContactReadAuthorityV1 =
  | {
      decision: 'allow'
      principal: ContactReaderPrincipalV1
      licenceView: ContactLicenceViewV1
      policyVersion: typeof CONTACT_READ_AUTHORITY_POLICY_VERSION_V1
    }
  | { decision: 'deny'; reason: ContactReadAuthorityDenialV1 }

/** What Identity Access verified for this request. Nothing here is client-held. */
export type ContactReadAuthorityInputsV1 =
  | { staffCookie: 'present'; staffPrincipal: { userId: string; role: string } | null }
  | { staffCookie: 'absent'; staffSessionEnforced: boolean; integrationAdminVerified: boolean }

function isReaderRole(role: unknown): role is ContactReaderRoleV1 {
  return typeof role === 'string' && (CONTACT_READER_ROLES_V1 as readonly string[]).includes(role)
}

/** The ВУ view of a staff reader role: every reader role sees the full number (Owner 2026-11-11). */
export function contactLicenceViewForRoleV1(_role: ContactReaderRoleV1): ContactLicenceViewV1 {
  return 'full'
}

function deny(reason: ContactReadAuthorityDenialV1): ContactReadAuthorityV1 {
  return { decision: 'deny', reason }
}

export function decideContactReadAuthorityV1(inputs: ContactReadAuthorityInputsV1): ContactReadAuthorityV1 {
  if (inputs.staffCookie === 'present') {
    const staff = inputs.staffPrincipal
    if (staff === null || typeof staff.userId !== 'string' || staff.userId === '' || !isReaderRole(staff.role)) {
      return deny('staff_session_refused')
    }
    return {
      decision: 'allow',
      principal: { kind: 'staff_session', userId: staff.userId, role: staff.role },
      licenceView: contactLicenceViewForRoleV1(staff.role),
      policyVersion: CONTACT_READ_AUTHORITY_POLICY_VERSION_V1,
    }
  }
  if (inputs.staffSessionEnforced === true) return deny('transitional_admin_read_disabled')
  if (inputs.integrationAdminVerified !== true) return deny('no_session')
  return {
    decision: 'allow',
    principal: { kind: 'integration_admin_session', transitional: true },
    licenceView: 'full',
    policyVersion: CONTACT_READ_AUTHORITY_POLICY_VERSION_V1,
  }
}
