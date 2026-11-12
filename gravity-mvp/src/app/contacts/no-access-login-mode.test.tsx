import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Owner acceptance, 2026-11-12: on a stand without personal passwords, «Войти»
 * led to the legacy employee picker, which no reader accepts — a loop. The
 * no-access screens of «Люди» and the card offer «Войти» only in password mode.
 */
const mocks = vi.hoisted(() => ({ mode: vi.fn(), authority: vi.fn(), card: vi.fn() }))
vi.mock('@/modules/identity-access/public/v1/staff-session', () => ({ getStaffLoginModeV1: mocks.mode }))
vi.mock('@/modules/contacts/public/v1', () => ({ resolveContactReadAuthorityV1: mocks.authority }))
vi.mock('@/modules/platform-shell/public/v1', () => ({ loadContactPersonCardV1: mocks.card }))
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound') }, redirect: () => { throw new Error('redirect') } }))
vi.mock('./ContactsSearchClient', () => ({ default: () => null }))
vi.mock('./LicenceSearchClient', () => ({ default: () => null }))

import ContactsPage from './page'
import ContactPersonPage from './[id]/page'

const people = async () => renderToStaticMarkup(await ContactsPage())
const card = async () => renderToStaticMarkup(await ContactPersonPage({ params: { id: 'contact-1' } }))

describe('no-access screens and the login mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authority.mockResolvedValue({ decision: 'deny', reason: 'no_session' })
    mocks.card.mockResolvedValue({ status: 'forbidden' })
  })

  it('in password mode both offer «Войти» to /login and the admin sign-in', async () => {
    mocks.mode.mockResolvedValue('password')
    for (const html of [await people(), await card()]) {
      expect(html).toContain('href="/login"')
      expect(html).toMatch(/[Вв]ойдите в CRM со своим паролем/u)
      expect(html).toContain('/settings/integrations/access?next=')
    }
  })

  it('in legacy or unavailable mode neither offers «Войти»; they say the password sign-in is not set up and keep the admin sign-in', async () => {
    for (const mode of ['legacy', 'unavailable']) {
      mocks.mode.mockResolvedValue(mode)
      for (const html of [await people(), await card()]) {
        expect(html).not.toContain('href="/login"')
        expect(html).toContain('Вход по паролю на этом стенде не настроен.')
        expect(html).toContain('/settings/integrations/access?next=')
      }
    }
  })

  it('an admitted reader is not asked about the login mode', async () => {
    mocks.authority.mockResolvedValue({ decision: 'allow', principal: { kind: 'staff_session', userId: 'u1', role: 'Менеджер' }, licenceView: 'full', policyVersion: 'x' })
    await people()
    expect(mocks.mode).not.toHaveBeenCalled()
  })
})
