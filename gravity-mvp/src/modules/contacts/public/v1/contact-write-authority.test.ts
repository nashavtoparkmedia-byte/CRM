/**
 * ContactWriteAuthorityQuery.v1 as a pure decision: who may change a person's
 * links and the actor every change records (ORCH Q1, Security W1–W8).
 */
import { describe, expect, it } from 'vitest'
import {
  CONTACT_TRANSITIONAL_ADMIN_ACTOR_V1,
  CONTACT_WRITE_AUTHORITY_POLICY_VERSION_V1,
  decideContactWriteAuthorityV1,
} from './contact-write-authority'

const staff = (role: string, userId = 'user-1') => ({ staffCookie: 'present' as const, staffPrincipal: { userId, role } })

describe('decideContactWriteAuthorityV1', () => {
  it('lets exactly the three staff roles write, recording the employee as the actor', () => {
    for (const role of ['Администратор', 'Руководитель', 'Менеджер']) {
      expect(decideContactWriteAuthorityV1(staff(role))).toEqual({
        decision: 'allow',
        principal: { kind: 'staff_session', userId: 'user-1', role },
        actor: 'staff:user-1',
        policyVersion: CONTACT_WRITE_AUTHORITY_POLICY_VERSION_V1,
      })
    }
  })

  it('refuses a staff cookie that did not verify, an unknown role or an id that is not a plain id', () => {
    expect(decideContactWriteAuthorityV1({ staffCookie: 'present', staffPrincipal: null })).toEqual({ decision: 'deny', reason: 'staff_session_refused' })
    for (const role of ['Оператор', 'администратор', '']) {
      expect(decideContactWriteAuthorityV1(staff(role))).toEqual({ decision: 'deny', reason: 'staff_session_refused' })
    }
    for (const userId of ['', 'user 1', 'staff:user-1', 'x'.repeat(65), 'юзер']) {
      expect(decideContactWriteAuthorityV1(staff('Менеджер', userId))).toEqual({ decision: 'deny', reason: 'staff_session_refused' })
    }
  })

  it('admits the integration-admin session only transitionally, with its constant actor, and ends it under ENFORCE', () => {
    expect(decideContactWriteAuthorityV1({ staffCookie: 'absent', staffSessionEnforced: false, integrationAdminVerified: true })).toEqual({
      decision: 'allow',
      principal: { kind: 'integration_admin_session', transitional: true },
      actor: CONTACT_TRANSITIONAL_ADMIN_ACTOR_V1,
      policyVersion: CONTACT_WRITE_AUTHORITY_POLICY_VERSION_V1,
    })
    expect(decideContactWriteAuthorityV1({ staffCookie: 'absent', staffSessionEnforced: false, integrationAdminVerified: false })).toEqual({ decision: 'deny', reason: 'no_session' })
    for (const integrationAdminVerified of [true, false]) {
      expect(decideContactWriteAuthorityV1({ staffCookie: 'absent', staffSessionEnforced: true, integrationAdminVerified })).toEqual({ decision: 'deny', reason: 'transitional_admin_write_disabled' })
    }
  })

  it('has no input through which a staff writer could become the admin actor', () => {
    const answer = decideContactWriteAuthorityV1({
      staffCookie: 'present',
      staffPrincipal: { userId: 'user-2', role: 'Менеджер' },
      // @ts-expect-error an admin input is not part of the staff branch
      integrationAdminVerified: true,
    })
    expect(answer).toMatchObject({ decision: 'allow', actor: 'staff:user-2' })
  })
})
