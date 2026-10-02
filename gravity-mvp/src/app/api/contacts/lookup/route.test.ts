/**
 * The ContactLookup.v1 browser transport proven as a pass-through.
 *
 * It must hand the public query inputs to searchContactsV1 unchanged and return
 * the capability's result unchanged: no ranking, filtering, display or provider
 * semantics of its own, and no failure detail in its response.
 */
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ search: vi.fn() }))

vi.mock('@/modules/contacts/public/v1', () => ({ searchContactsV1: mocks.search }))

import { GET } from './route'

function request(search: string) {
  return new NextRequest(`https://crm.example/api/contacts/lookup${search}`)
}

const RESULT = {
  items: [
    { contactId: 'contact-2', displayName: 'Пётр Сидоров', displayTitle: 'Пётр Сидоров', primaryPhone: null, channels: ['max'] },
    { contactId: 'contact-1', displayName: 'Иван Петров', displayTitle: 'Иван Петров · +7 900 123-45-67', primaryPhone: '+7 900 123-45-67', channels: [] },
  ],
  total: 2,
  truncated: true,
}

describe('GET /api/contacts/lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.search.mockResolvedValue(RESULT)
  })

  test('passes the query and limit to the capability and returns its result unchanged', async () => {
    const response = await GET(request('?q=%D0%98%D0%B2&limit=5'))
    expect(response.status).toBe(200)
    expect(mocks.search).toHaveBeenCalledTimes(1)
    expect(mocks.search).toHaveBeenCalledWith({ query: 'Ив', limit: 5 })
    // Order, truncation and every field come from ContactLookup.v1 as given.
    await expect(response.json()).resolves.toEqual(RESULT)
  })

  test('leaves query validity and limit bounds to the capability', async () => {
    await GET(request(''))
    expect(mocks.search).toHaveBeenLastCalledWith({ query: null, limit: undefined })
    await GET(request('?q=%20&limit=abc'))
    expect(mocks.search).toHaveBeenLastCalledWith({ query: ' ', limit: undefined })
    await GET(request('?q=79001234567&limit=1000'))
    expect(mocks.search).toHaveBeenLastCalledWith({ query: '79001234567', limit: 1000 })
    await GET(request('?q=Ив&limit='))
    expect(mocks.search).toHaveBeenLastCalledWith({ query: 'Ив', limit: undefined })
  })

  test('returns a generic error and never the cause', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.search.mockRejectedValue(new Error('PrismaClientKnownRequestError P2024 db.internal:5432'))
    const response = await GET(request('?q=Ив'))
    expect(response.status).toBe(500)
    const text = await response.text()
    expect(text).toBe(JSON.stringify({ error: 'Internal Server Error' }))
    expect(text).not.toContain('P2024')
    errors.mockRestore()
  })
})
