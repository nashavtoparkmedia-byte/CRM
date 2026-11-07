// The browser transport for ContactLookup.v1: a ContactLookupClientV1 that
// ContactSelector can be given, backed by GET /api/contacts/lookup.
//
// It owns no lookup semantics. Query validity, limit bounds, ranking, ordering
// and the provider-neutral title all come from the capability; this only moves
// the request and checks the response has the declared shape. Each item is
// re-built from the five declared fields, so a field the server ever adds by
// mistake cannot ride into a consumer's selection state. A failure surfaces as a
// fixed error, never the server's text.

import type { ContactLookupItemV1, ContactLookupResultV1 } from '../contact-lookup'
import type { ContactLookupClientV1 } from './ContactSelector'

export const CONTACT_LOOKUP_ENDPOINT_V1 = '/api/contacts/lookup'

/** The one error a consumer sees, whatever went wrong. */
export class ContactLookupRequestErrorV1 extends Error {
  constructor() {
    super('CONTACT_LOOKUP_FAILED')
    this.name = 'ContactLookupRequestErrorV1'
  }
}

function lookupItem(value: unknown): ContactLookupItemV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.contactId !== 'string' || record.contactId === '') return null
  if (typeof record.displayName !== 'string' || typeof record.displayTitle !== 'string') return null
  if (record.primaryPhone !== null && typeof record.primaryPhone !== 'string') return null
  if (!Array.isArray(record.channels) || !record.channels.every(channel => typeof channel === 'string')) return null
  return {
    contactId: record.contactId,
    displayName: record.displayName,
    displayTitle: record.displayTitle,
    primaryPhone: record.primaryPhone,
    channels: [...record.channels],
  }
}

function lookupResult(value: unknown): ContactLookupResultV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContactLookupRequestErrorV1()
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.items)) throw new ContactLookupRequestErrorV1()
  const items = record.items.map(lookupItem)
  // A malformed item means the response cannot be trusted as a whole.
  if (items.some(item => item === null)) throw new ContactLookupRequestErrorV1()
  const valid = items as ContactLookupItemV1[]
  return { items: valid, total: valid.length, truncated: record.truncated === true }
}

export function createHttpContactLookupClientV1(
  options: { fetch?: typeof fetch } = {},
): ContactLookupClientV1 {
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  return async ({ query, limit }) => {
    const params = new URLSearchParams({ q: query })
    if (limit !== undefined) params.set('limit', String(limit))
    let response: Response
    try {
      response = await send(`${CONTACT_LOOKUP_ENDPOINT_V1}?${params.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      })
    } catch {
      throw new ContactLookupRequestErrorV1()
    }
    if (!response.ok) throw new ContactLookupRequestErrorV1()
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new ContactLookupRequestErrorV1()
    }
    return lookupResult(body)
  }
}
