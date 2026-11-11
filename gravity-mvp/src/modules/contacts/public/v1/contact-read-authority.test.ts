/**
 * ContactReadAuthorityQuery.v1 proven as a fail-closed, non-elevating decision.
 *
 * The decision is pure: these tests cover the whole table the Owner approved
 * (D2): the three staff roles and their ВУ views, a refused staff cookie, the
 * transitional integration-admin path and the enforcement switch that ends it.
 */
import { describe, expect, it } from 'vitest'

import {
  CONTACT_READ_AUTHORITY_POLICY_VERSION_V1,
  contactLicenceViewForRoleV1,
  decideContactReadAuthorityV1,
} from './contact-read-authority'

const staff = (role: string, userId = 'user-1') => ({ staffCookie: 'present' as const, staffPrincipal: { userId, role } })

describe('decideContactReadAuthorityV1', () => {
  it('lets every reader role read people, with the full ВУ for Администратор only', () => {
    expect(decideContactReadAuthorityV1(staff('Администратор'))).toEqual({
      decision: 'allow',
      principal: { kind: 'staff_session', userId: 'user-1', role: 'Администратор' },
      licenceView: 'full',
      policyVersion: CONTACT_READ_AUTHORITY_POLICY_VERSION_V1,
    })
    for (const role of ['Руководитель', 'Менеджер']) {
      expect(decideContactReadAuthorityV1(staff(role))).toEqual({
        decision: 'allow',
        principal: { kind: 'staff_session', userId: 'user-1', role },
        licenceView: 'last4',
        policyVersion: CONTACT_READ_AUTHORITY_POLICY_VERSION_V1,
      })
    }
  })

  it('refuses a staff cookie that did not verify, an unknown role or an empty user', () => {
    expect(decideContactReadAuthorityV1({ staffCookie: 'present', staffPrincipal: null }))
      .toEqual({ decision: 'deny', reason: 'staff_session_refused' })
    for (const role of ['Оператор', 'администратор', '', 'Administrator']) {
      expect(decideContactReadAuthorityV1(staff(role))).toEqual({ decision: 'deny', reason: 'staff_session_refused' })
    }
    expect(decideContactReadAuthorityV1(staff('Администратор', ''))).toEqual({ decision: 'deny', reason: 'staff_session_refused' })
  })

  it('admits the integration-admin session only as the transitional path, with the full view', () => {
    expect(decideContactReadAuthorityV1({ staffCookie: 'absent', staffSessionEnforced: false, integrationAdminVerified: true })).toEqual({
      decision: 'allow',
      principal: { kind: 'integration_admin_session', transitional: true },
      licenceView: 'full',
      policyVersion: CONTACT_READ_AUTHORITY_POLICY_VERSION_V1,
    })
    expect(decideContactReadAuthorityV1({ staffCookie: 'absent', staffSessionEnforced: false, integrationAdminVerified: false }))
      .toEqual({ decision: 'deny', reason: 'no_session' })
  })

  it('ends the transitional path when Staff Session is enforced, whatever the admin session says', () => {
    for (const integrationAdminVerified of [true, false]) {
      expect(decideContactReadAuthorityV1({ staffCookie: 'absent', staffSessionEnforced: true, integrationAdminVerified }))
        .toEqual({ decision: 'deny', reason: 'transitional_admin_read_disabled' })
    }
  })

  it('has no input through which a staff user could be raised to the admin view', () => {
    // A present staff cookie has no integration-admin input at all: the type
    // admits none, and a Менеджер stays 'last4' whatever else the request holds.
    const answer = decideContactReadAuthorityV1({
      staffCookie: 'present',
      staffPrincipal: { userId: 'user-2', role: 'Менеджер' },
      // @ts-expect-error an admin input is not part of the staff branch
      integrationAdminVerified: true,
    })
    expect(answer).toMatchObject({ decision: 'allow', licenceView: 'last4' })
  })

  it('maps only Администратор to the full ВУ view', () => {
    expect(contactLicenceViewForRoleV1('Администратор')).toBe('full')
    expect(contactLicenceViewForRoleV1('Руководитель')).toBe('last4')
    expect(contactLicenceViewForRoleV1('Менеджер')).toBe('last4')
  })
})
