/**
 * The Identity Access feed of ContactReadAuthorityQuery.v1, and the person-card
 * authority bound to it.
 *
 * These prove the reading ORDER the no-elevation rule rests on: with a staff
 * cookie present only Staff Session is asked; the enforcement switch and the
 * transitional integration-admin session are asked only without one. They also
 * prove that the role is read per request (a mid-session role change applies at
 * once) and that the card authority admits exactly the two reader kinds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ia = vi.hoisted(() => ({
  hasStaffSessionCookieV1: vi.fn<() => Promise<boolean>>(),
  getStaffSessionPrincipalV1: vi.fn<() => Promise<{ kind: 'staff_session'; userId: string; role: string } | null>>(),
  isStaffSessionEnforcedForRequestV1: vi.fn<() => boolean>(),
  getIntegrationAdminPrincipal: vi.fn<() => Promise<{ kind: 'integration_admin_session' } | null>>(),
}))

vi.mock('@/modules/identity-access/public/v1', () => ({
  getStaffSessionPrincipalV1: ia.getStaffSessionPrincipalV1,
  getIntegrationAdminPrincipal: ia.getIntegrationAdminPrincipal,
}))
vi.mock('@/modules/identity-access/public/v1/staff-session', () => ({
  hasStaffSessionCookieV1: ia.hasStaffSessionCookieV1,
  isStaffSessionEnforcedForRequestV1: ia.isStaffSessionEnforcedForRequestV1,
}))

import { resolveContactReadAuthorityFromIdentityAccessV1 } from './identity-access-contact-read-authority'
import { identityAccessContactPersonCardAuthorityV1 } from './identity-access-contact-person-card-authority'

function employee(role: string) {
  return { kind: 'staff_session' as const, userId: 'user-7', role, sid: 'sid', issuedAt: 1, expiresAt: 2 }
}

beforeEach(() => {
  for (const mock of Object.values(ia)) mock.mockReset()
  ia.isStaffSessionEnforcedForRequestV1.mockReturnValue(false)
  ia.getIntegrationAdminPrincipal.mockResolvedValue({ kind: 'integration_admin_session' })
})

describe('resolveContactReadAuthorityFromIdentityAccessV1', () => {
  it('lets the staff role decide when both sessions are present, never consulting the admin session', async () => {
    ia.hasStaffSessionCookieV1.mockResolvedValue(true)
    ia.getStaffSessionPrincipalV1.mockResolvedValue(employee('Менеджер'))
    await expect(resolveContactReadAuthorityFromIdentityAccessV1()).resolves.toMatchObject({
      decision: 'allow',
      principal: { kind: 'staff_session', userId: 'user-7', role: 'Менеджер' },
      licenceView: 'full',
    })
    expect(ia.getIntegrationAdminPrincipal).not.toHaveBeenCalled()
    expect(ia.isStaffSessionEnforcedForRequestV1).not.toHaveBeenCalled()
  })

  it('refuses a staff cookie that does not verify, even beside a valid admin session', async () => {
    ia.hasStaffSessionCookieV1.mockResolvedValue(true)
    ia.getStaffSessionPrincipalV1.mockResolvedValue(null)
    await expect(resolveContactReadAuthorityFromIdentityAccessV1())
      .resolves.toEqual({ decision: 'deny', reason: 'staff_session_refused' })
    expect(ia.getIntegrationAdminPrincipal).not.toHaveBeenCalled()
  })

  it('applies a role change at once: the role is read per request, never cached', async () => {
    ia.hasStaffSessionCookieV1.mockResolvedValue(true)
    ia.getStaffSessionPrincipalV1.mockResolvedValueOnce(employee('Администратор')).mockResolvedValueOnce(employee('Менеджер')).mockResolvedValueOnce(null)
    await expect(resolveContactReadAuthorityFromIdentityAccessV1()).resolves.toMatchObject({ principal: { role: 'Администратор' } })
    await expect(resolveContactReadAuthorityFromIdentityAccessV1()).resolves.toMatchObject({ principal: { role: 'Менеджер' } })
    // A session that no longer verifies (disabled employee, revoked session) is refused at once.
    await expect(resolveContactReadAuthorityFromIdentityAccessV1()).resolves.toEqual({ decision: 'deny', reason: 'staff_session_refused' })
  })

  it('ends the transitional admin read once Staff Session is enforced, without reading the admin session', async () => {
    ia.hasStaffSessionCookieV1.mockResolvedValue(false)
    ia.isStaffSessionEnforcedForRequestV1.mockReturnValue(true)
    await expect(resolveContactReadAuthorityFromIdentityAccessV1())
      .resolves.toEqual({ decision: 'deny', reason: 'transitional_admin_read_disabled' })
    expect(ia.getIntegrationAdminPrincipal).not.toHaveBeenCalled()
  })

  it('admits the integration-admin session transitionally, and nobody without a verified session', async () => {
    ia.hasStaffSessionCookieV1.mockResolvedValue(false)
    await expect(resolveContactReadAuthorityFromIdentityAccessV1()).resolves.toMatchObject({
      decision: 'allow',
      principal: { kind: 'integration_admin_session', transitional: true },
      licenceView: 'full',
    })
    // Only crm_user_id (or nothing) on the request: no staff cookie, no admin session.
    ia.getIntegrationAdminPrincipal.mockResolvedValue(null)
    await expect(resolveContactReadAuthorityFromIdentityAccessV1()).resolves.toEqual({ decision: 'deny', reason: 'no_session' })
    expect(ia.getStaffSessionPrincipalV1).not.toHaveBeenCalled()
  })
})

describe('identityAccessContactPersonCardAuthorityV1', () => {
  it('hands the card the reader kind and its ВУ view, and nothing for a denial', async () => {
    ia.hasStaffSessionCookieV1.mockResolvedValue(true)
    ia.getStaffSessionPrincipalV1.mockResolvedValue(employee('Руководитель'))
    await expect(identityAccessContactPersonCardAuthorityV1.currentPrincipal())
      .resolves.toEqual({ kind: 'staff_session', licenceView: 'full' })
    ia.getStaffSessionPrincipalV1.mockResolvedValue(null)
    await expect(identityAccessContactPersonCardAuthorityV1.currentPrincipal()).resolves.toBeNull()
    ia.hasStaffSessionCookieV1.mockResolvedValue(false)
    await expect(identityAccessContactPersonCardAuthorityV1.currentPrincipal())
      .resolves.toEqual({ kind: 'integration_admin_session', licenceView: 'full' })
  })

  it('admits exactly the two reader kinds', async () => {
    for (const kind of ['staff_session', 'integration_admin_session']) {
      await expect(identityAccessContactPersonCardAuthorityV1.mayReadContact({ kind }, 'contact-1')).resolves.toBe(true)
    }
    for (const kind of ['mobile_session', 'staff_session_refused', 'crm_user', '']) {
      await expect(identityAccessContactPersonCardAuthorityV1.mayReadContact({ kind }, 'contact-1')).resolves.toBe(false)
    }
  })
})
