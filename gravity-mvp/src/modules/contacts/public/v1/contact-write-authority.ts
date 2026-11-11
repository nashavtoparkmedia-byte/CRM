// contacts.ContactWriteAuthorityQuery.v1 — who may change a person's links in
// Contacts, and the actor every change records (Contact Identity V2; ORCH Q1
// 2026-11-11, consistent with the Owner's «Полный доступ всем»; Security design
// PASS with conditions W1–W8).
//
// The same fail-closed, non-elevating order as ContactReadAuthorityQuery.v1:
// 1. A staff session cookie decides alone. A verified Менеджер, Руководитель or
//    Администратор may write, and the actor is 'staff:<userId>'; a cookie that
//    does not verify is a denial and the integration-admin session is not read.
// 2. Without a staff cookie and with Staff Session enforced, nobody writes.
// 3. Without a staff cookie and without enforcement, a verified
//    integration-admin session writes TRANSITIONALLY, recorded as the session's
//    existing constant actor.
// The actor is taken only from this answer, never from a request body, header,
// query or crm_user_id. This module is pure; the Identity Access reads that feed
// it live in internal/identity-access-contact-write-authority.ts.
import { CONTACT_READER_ROLES_V1, type ContactReaderRoleV1 } from './contact-read-authority'

export const CONTACT_WRITE_AUTHORITY_QUERY_V1 = 'contacts.ContactWriteAuthorityQuery.v1' as const
export const CONTACT_WRITE_AUTHORITY_POLICY_VERSION_V1 = 'contacts.write-authority.v1' as const
/** The actor the transitional integration-admin session records; the only actor literal. */
export const CONTACT_TRANSITIONAL_ADMIN_ACTOR_V1 = 'identity-access:integration-admin-session' as const

export type ContactWriterPrincipalV1 =
  | { kind: 'staff_session'; userId: string; role: ContactReaderRoleV1 }
  /** Transitional: ends when Staff Session is enforced in production. */
  | { kind: 'integration_admin_session'; transitional: true }

export type ContactWriteAuthorityDenialV1 = 'no_session' | 'staff_session_refused' | 'transitional_admin_write_disabled'

export type ContactWriteAuthorityV1 =
  | {
      decision: 'allow'
      principal: ContactWriterPrincipalV1
      /** The actor every write of this request records. */
      actor: string
      policyVersion: typeof CONTACT_WRITE_AUTHORITY_POLICY_VERSION_V1
    }
  | { decision: 'deny'; reason: ContactWriteAuthorityDenialV1 }

export type ContactWriteAuthorityInputsV1 =
  | { staffCookie: 'present'; staffPrincipal: { userId: string; role: string } | null }
  | { staffCookie: 'absent'; staffSessionEnforced: boolean; integrationAdminVerified: boolean }

const STAFF_USER_ID = /^[A-Za-z0-9_-]{1,64}$/u

function deny(reason: ContactWriteAuthorityDenialV1): ContactWriteAuthorityV1 {
  return { decision: 'deny', reason }
}

export function decideContactWriteAuthorityV1(inputs: ContactWriteAuthorityInputsV1): ContactWriteAuthorityV1 {
  if (inputs.staffCookie === 'present') {
    const staff = inputs.staffPrincipal
    if (staff === null || typeof staff.userId !== 'string' || !STAFF_USER_ID.test(staff.userId)
      || !(CONTACT_READER_ROLES_V1 as readonly string[]).includes(staff.role)) {
      return deny('staff_session_refused')
    }
    return {
      decision: 'allow',
      principal: { kind: 'staff_session', userId: staff.userId, role: staff.role as ContactReaderRoleV1 },
      actor: `staff:${staff.userId}`,
      policyVersion: CONTACT_WRITE_AUTHORITY_POLICY_VERSION_V1,
    }
  }
  if (inputs.staffSessionEnforced === true) return deny('transitional_admin_write_disabled')
  if (inputs.integrationAdminVerified !== true) return deny('no_session')
  return {
    decision: 'allow',
    principal: { kind: 'integration_admin_session', transitional: true },
    actor: CONTACT_TRANSITIONAL_ADMIN_ACTOR_V1,
    policyVersion: CONTACT_WRITE_AUTHORITY_POLICY_VERSION_V1,
  }
}
