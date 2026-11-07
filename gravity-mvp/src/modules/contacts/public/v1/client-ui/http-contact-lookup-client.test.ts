/**
 * The ContactLookup.v1 browser transport proven as plumbing only.
 *
 * It must call exactly the lookup endpoint with the public inputs, return the
 * capability's items in the order received, keep only the declared item
 * fields, and turn every failure into one fixed error with no server text.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  CONTACT_LOOKUP_ENDPOINT_V1,
  ContactLookupRequestErrorV1,
  createHttpContactLookupClientV1,
} from './http-contact-lookup-client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const ITEM_B = { contactId: 'contact-b', displayName: 'Пётр', displayTitle: 'Пётр', primaryPhone: null, channels: ['max'] }
const ITEM_A = { contactId: 'contact-a', displayName: 'Иван', displayTitle: 'Иван · +7 900 123-45-67', primaryPhone: '+7 900 123-45-67', channels: ['telegram'] }

describe('createHttpContactLookupClientV1', () => {
  it('calls only the lookup endpoint with the public query inputs', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ items: [], total: 0, truncated: false }))
    const lookup = createHttpContactLookupClientV1({ fetch: fetchSpy as unknown as typeof fetch })
    await lookup({ query: 'Иван Петров' })
    await lookup({ query: '+7 900', limit: 5 })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const [first, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(first).toBe(`${CONTACT_LOOKUP_ENDPOINT_V1}?q=%D0%98%D0%B2%D0%B0%D0%BD+%D0%9F%D0%B5%D1%82%D1%80%D0%BE%D0%B2`)
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' })
    expect((fetchSpy.mock.calls[1] as unknown as [string])[0]).toBe(`${CONTACT_LOOKUP_ENDPOINT_V1}?q=%2B7+900&limit=5`)
  })

  it('returns items in exactly the order received and keeps truncation', async () => {
    const lookup = createHttpContactLookupClientV1({
      fetch: (async () => jsonResponse({ items: [ITEM_B, ITEM_A], total: 2, truncated: true })) as unknown as typeof fetch,
    })
    await expect(lookup({ query: 'Ив' })).resolves.toEqual({ items: [ITEM_B, ITEM_A], total: 2, truncated: true })
  })

  it('keeps only the declared item fields, so extra server data cannot reach selection state', async () => {
    const smuggled = {
      ...ITEM_A,
      externalId: 'EXT-902100000001',
      providerAccountId: 'PA-tg-bot-7712345678',
      chatId: 'CHAT-smuggled',
      hasChat: { telegram: 'CHAT-smuggled' },
      reachabilityStatus: 'confirmed',
    }
    const lookup = createHttpContactLookupClientV1({
      fetch: (async () => jsonResponse({ items: [smuggled], total: 1, truncated: false, chats: ['x'] })) as unknown as typeof fetch,
    })
    const result = await lookup({ query: 'Ив' })
    expect(result).toEqual({ items: [ITEM_A], total: 1, truncated: false })
    expect(Object.keys(result.items[0]).sort()).toEqual(['channels', 'contactId', 'displayName', 'displayTitle', 'primaryPhone'])
    const serialized = JSON.stringify(result)
    for (const value of ['EXT-902100000001', 'PA-tg-bot-7712345678', 'CHAT-smuggled', 'reachabilityStatus', 'chats']) {
      expect(serialized).not.toContain(value)
    }
  })

  it('turns every failure into one fixed error with no server text', async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => jsonResponse({ error: 'PrismaClientKnownRequestError P2024' }, 500),
      async () => new Response('<html>502 Bad Gateway</html>', { status: 200 }),
      async () => jsonResponse({ results: [] }),
      async () => jsonResponse({ items: [{ contactId: 7 }] }),
      async () => jsonResponse({ items: [{ ...ITEM_A, primaryPhone: 79001234567 }] }),
      async () => { throw new TypeError('NetworkError: secret-host.internal unreachable') },
    ]
    for (const respond of cases) {
      const lookup = createHttpContactLookupClientV1({ fetch: respond as unknown as typeof fetch })
      const failure = await lookup({ query: 'Ив' }).then(() => null, (error: unknown) => error)
      expect(failure).toBeInstanceOf(ContactLookupRequestErrorV1)
      expect((failure as Error).message).toBe('CONTACT_LOOKUP_FAILED')
    }
  })
})
