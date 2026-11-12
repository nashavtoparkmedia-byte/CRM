/**
 * GET /api/contacts/lookup answers only with Contacts' read authority.
 *
 * A denial of any kind (no session, a refused staff cookie, the transitional
 * admin read switched off) is 401 and never reaches the lookup. No answer may be
 * cached: 200, 401 and 500 all carry Cache-Control: no-store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const contacts = vi.hoisted(() => ({
  resolveContactReadAuthorityV1: vi.fn(),
  searchContactsV1: vi.fn(),
}))
vi.mock('@/modules/contacts/public/v1', () => contacts)

import { GET } from './route'

const request = (q = 'Иванов') => new NextRequest(`http://localhost/api/contacts/lookup?q=${encodeURIComponent(q)}`)

beforeEach(() => {
  contacts.resolveContactReadAuthorityV1.mockReset()
  contacts.searchContactsV1.mockReset().mockResolvedValue({ items: [], total: 0, truncated: false })
})

describe('GET /api/contacts/lookup', () => {
  it('refuses every denial with 401 and never searches', async () => {
    for (const reason of ['no_session', 'staff_session_refused', 'transitional_admin_read_disabled']) {
      contacts.resolveContactReadAuthorityV1.mockResolvedValueOnce({ decision: 'deny', reason })
      const response = await GET(request())
      expect(response.status).toBe(401)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect(contacts.searchContactsV1).not.toHaveBeenCalled()
  })

  it('searches for a verified employee of any reader role', async () => {
    for (const role of ['Администратор', 'Руководитель', 'Менеджер']) {
      contacts.resolveContactReadAuthorityV1.mockResolvedValueOnce({
        decision: 'allow',
        principal: { kind: 'staff_session', userId: 'u', role },
        licenceView: 'full',
        policyVersion: 'contacts.read-authority.v1',
      })
      const response = await GET(request())
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect(contacts.searchContactsV1).toHaveBeenCalledTimes(3)
    expect(contacts.searchContactsV1).toHaveBeenCalledWith({ query: 'Иванов', limit: undefined })
  })

  it('evaluates the authority exactly once per request', async () => {
    contacts.resolveContactReadAuthorityV1.mockResolvedValue({
      decision: 'allow',
      principal: { kind: 'integration_admin_session', transitional: true },
      licenceView: 'full',
      policyVersion: 'contacts.read-authority.v1',
    })
    await GET(request())
    expect(contacts.resolveContactReadAuthorityV1).toHaveBeenCalledTimes(1)
  })

  it('answers a lookup failure with 500, no-store and no cause', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    contacts.resolveContactReadAuthorityV1.mockResolvedValue({
      decision: 'allow',
      principal: { kind: 'staff_session', userId: 'u', role: 'Менеджер' },
      licenceView: 'full',
      policyVersion: 'contacts.read-authority.v1',
    })
    contacts.searchContactsV1.mockRejectedValueOnce(new Error('relation "Contact" does not exist'))
    const response = await GET(request())
    expect(response.status).toBe(500)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('{"error":"Internal Server Error"}')
  })
})
