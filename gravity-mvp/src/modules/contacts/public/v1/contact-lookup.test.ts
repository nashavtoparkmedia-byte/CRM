/**
 * ContactLookup.v1 proven as a provider-neutral, deterministic, bounded lookup.
 *
 * The point of these tests is not that rows are copied. It is that a distinctive
 * provider external id can never reach a human-readable field by any path, that
 * rank precedence holds BEFORE truncation rather than after it, that ordering does
 * not depend on the ambient locale, and that a refused query never touches the
 * database.
 */
import { describe, expect, it } from 'vitest'

import {
  CONTACT_LOOKUP_DEFAULT_LIMIT_V1,
  CONTACT_LOOKUP_MAX_LIMIT_V1,
  buildContactLookupItemV1,
  contactLookupCriteriaV1,
  contactLookupLimitV1,
  contactLookupSortKeyV1,
  createSearchContactsHandlerV1,
  type ContactLookupPortV1,
  type ContactLookupRankClassV1,
  type ContactLookupSourceV1,
} from './contact-lookup'

const PROVIDER_EXTERNAL_ID = '902100000001'
const PROVIDER_ACCOUNT_ID = 'tg-bot-7712345678'
const WHATSAPP_JID = '79990001122@c.us'

function source(overrides: Partial<ContactLookupSourceV1> = {}): ContactLookupSourceV1 {
  return {
    id: 'contact-1',
    displayName: 'Иван Петров',
    displayNameSource: 'channel',
    primaryPhoneId: 'phone-1',
    customFields: {},
    phones: [{ id: 'phone-1', phone: '79001234567', isPrimary: true, isActive: true, verifiedAt: null }],
    identities: [{ channel: 'telegram', isActive: true, displayName: null }],
    ...overrides,
  }
}

/** A port whose every call is recorded, so "no database call" is provable. */
function recordingPort(behaviour: {
  ids?: Partial<Record<ContactLookupRankClassV1, string[]>>
  sources?: ContactLookupSourceV1[]
}) {
  const calls: Array<{ kind: 'candidates' | 'sources'; detail: unknown }> = []
  const port: ContactLookupPortV1 = {
    async findContactLookupCandidateIds(criteria, rankClass, limit) {
      calls.push({ kind: 'candidates', detail: { criteria, rankClass, limit } })
      return (behaviour.ids?.[rankClass] ?? []).slice(0, limit)
    },
    async findContactLookupSources(contactIds) {
      calls.push({ kind: 'sources', detail: [...contactIds] })
      const known = behaviour.sources ?? []
      return contactIds
        .map(id => known.find(item => item.id === id) ?? source({ id, displayName: `Контакт ${id}` }))
    },
  }
  return { port, calls }
}

describe('contactLookupCriteriaV1', () => {
  it('classifies a phone query by its digits', () => {
    expect(contactLookupCriteriaV1('+7 (900) 123-45-67')).toEqual({ kind: 'phone', digits: '79001234567' })
    expect(contactLookupCriteriaV1('123')).toEqual({ kind: 'phone', digits: '123' })
  })

  it('classifies anything else as a display-name query', () => {
    expect(contactLookupCriteriaV1('  Иван  ')).toEqual({ kind: 'text', text: 'Иван' })
    expect(contactLookupCriteriaV1('Ив')).toEqual({ kind: 'text', text: 'Ив' })
  })

  it('refuses a query no match could satisfy', () => {
    for (const query of ['', '   ', 'и', '1', '12', '+7', '()', null, undefined, 7, {}, ['Иван'], 'Иван\u0000']) {
      expect(contactLookupCriteriaV1(query as never)).toBeNull()
    }
  })
})

describe('contactLookupLimitV1', () => {
  it('defaults, clamps and floors', () => {
    expect(contactLookupLimitV1(null)).toBe(CONTACT_LOOKUP_DEFAULT_LIMIT_V1)
    expect(contactLookupLimitV1(undefined)).toBe(CONTACT_LOOKUP_DEFAULT_LIMIT_V1)
    expect(contactLookupLimitV1(Number.NaN)).toBe(CONTACT_LOOKUP_DEFAULT_LIMIT_V1)
    expect(contactLookupLimitV1('8' as never)).toBe(CONTACT_LOOKUP_DEFAULT_LIMIT_V1)
    expect(contactLookupLimitV1(3)).toBe(3)
    expect(contactLookupLimitV1(3.9)).toBe(3)
    expect(contactLookupLimitV1(0)).toBe(1)
    expect(contactLookupLimitV1(-5)).toBe(1)
    expect(contactLookupLimitV1(1000)).toBe(CONTACT_LOOKUP_MAX_LIMIT_V1)
  })
})

describe('contactLookupSortKeyV1', () => {
  it('is a deterministic, locale-independent key', () => {
    expect(contactLookupSortKeyV1('ИВАН')).toBe(contactLookupSortKeyV1('иван'))
    // NFKC folds compatibility forms, so a full-width or ligature spelling of the
    // same name sorts with it rather than beside it.
    expect(contactLookupSortKeyV1('ﬁn')).toBe('fin')
    expect(contactLookupSortKeyV1(null)).toBe('')
    expect(contactLookupSortKeyV1(undefined)).toBe('')
  })
})

describe('buildContactLookupItemV1', () => {
  it('projects exactly the declared field set', () => {
    expect(Object.keys(buildContactLookupItemV1(source())).sort()).toEqual([
      'channels',
      'contactId',
      'displayName',
      'displayTitle',
      'primaryPhone',
    ])
  })

  it('titles a contact from the canonical provider-neutral policy', () => {
    expect(buildContactLookupItemV1(source())).toEqual({
      contactId: 'contact-1',
      displayName: 'Иван Петров',
      displayTitle: 'Иван Петров · +7 900 123-45-67',
      primaryPhone: '+7 900 123-45-67',
      channels: ['telegram'],
    })
  })

  it('reports a contact with no phone', () => {
    const item = buildContactLookupItemV1(source({ primaryPhoneId: null, phones: [] }))
    expect(item.primaryPhone).toBeNull()
    expect(item.displayTitle).toBe('Иван Петров')
  })

  it('reports no channels when no identity is active', () => {
    expect(buildContactLookupItemV1(source({ identities: [] })).channels).toEqual([])
    expect(buildContactLookupItemV1(source({
      identities: [{ channel: 'telegram', isActive: false, displayName: null }],
    })).channels).toEqual([])
  })

  it('lists active channels sorted and deduplicated, ignoring inactive ones', () => {
    expect(buildContactLookupItemV1(source({
      identities: [
        { channel: 'whatsapp', isActive: true, displayName: null },
        { channel: 'telegram', isActive: true, displayName: null },
        { channel: 'telegram', isActive: true, displayName: null },
        { channel: 'max', isActive: false, displayName: null },
        { channel: '  ', isActive: true, displayName: null },
      ],
    })).channels).toEqual(['telegram', 'whatsapp'])
  })

  it('uses the shared confirmed-person evidence for the title', () => {
    const customFields = {
      driverConfirmations: [{
        id: 'confirmation-1',
        profileClusterKey: 'vu:7700123456',
        representativeDriverId: 'driver-a',
        status: 'confirmed',
        evidenceSnapshot: {
          profiles: [{
            driverId: 'driver-a',
            fullName: 'Пётр Сидоров',
            externalParkId: 'park-1',
            externalDriverProfileId: 'profile-driver-a',
            evidenceRoot: 'yandex:park-1:profile-driver-a',
            sourceFreshness: 'fresh',
            phones: ['79990000000'],
          }],
          warnings: [],
        },
        confirmedAt: '2026-09-01T00:00:00.000Z',
      }],
    }
    expect(buildContactLookupItemV1(source({
      displayName: 'Контакт MAX',
      customFields,
    })).displayName).toBe('Пётр Сидоров')
  })

  it('honours a manually pinned canonical name above everything else', () => {
    expect(buildContactLookupItemV1(source({
      displayName: 'Пётр Сидоров',
      customFields: { canonicalPinnedAt: '2026-09-01T00:00:00.000Z' },
    })).displayName).toBe('Пётр Сидоров')
  })

  it('falls through a technical raw display name exactly as the shared policy does', () => {
    expect(buildContactLookupItemV1(source({ displayName: 'Контакт MAX' })).displayName)
      .toBe('+7 900 123-45-67')
    expect(buildContactLookupItemV1(source({
      displayName: 'Контакт TG',
      identities: [{ channel: 'telegram', isActive: true, displayName: 'Иван из Telegram' }],
      primaryPhoneId: null,
      phones: [],
    })).displayName).toBe('Иван из Telegram')
  })

  it('uses the generic fallback rather than any provider target', () => {
    const item = buildContactLookupItemV1(source({
      displayName: 'Контакт MAX',
      displayNameSource: 'channel',
      primaryPhoneId: null,
      phones: [],
      identities: [{ channel: 'max', isActive: true, displayName: WHATSAPP_JID }],
    }))
    expect(item.displayName).toBe('Контакт')
    expect(item.displayTitle).toBe('Контакт')
  })

  it('can never surface a provider external id as a name, whatever the source carries', () => {
    // The source type has no externalId field at all, so the only way a provider
    // target can reach the projection is through a display-name-shaped value. The
    // canonical technical-name filter must reject every such form.
    for (const providerShapedName of [
      PROVIDER_EXTERNAL_ID,
      WHATSAPP_JID,
      '79990001122@s.whatsapp.net',
      '120363000000000000@g.us',
      'max:9021',
      'MAX: 9021',
      'Контакт MAX',
      'Telegram 902100000001',
    ]) {
      const item = buildContactLookupItemV1(source({
        displayName: providerShapedName,
        displayNameSource: 'channel',
        primaryPhoneId: null,
        phones: [],
        identities: [{ channel: 'telegram', isActive: true, displayName: providerShapedName }],
      }))
      const serialized = JSON.stringify(item)
      expect(serialized).not.toContain(providerShapedName)
      expect(item.displayName).toBe('Контакт')
    }
  })

  it('carries no provider, chat, reachability or conflict vocabulary', () => {
    const serialized = JSON.stringify(buildContactLookupItemV1(source({
      customFields: {
        identityConflicts: [{ conflictType: 'channel_identity_collision', status: 'open', identityId: 'identity-9' }],
        phoneEvidenceByPhoneId: { 'phone-1': { trust: 'provider_bound', evidenceRoot: `tg:${PROVIDER_EXTERNAL_ID}` } },
      },
      identities: [{ channel: 'telegram', isActive: true, displayName: null }],
    })))
    for (const forbidden of [
      PROVIDER_EXTERNAL_ID, PROVIDER_ACCOUNT_ID, WHATSAPP_JID, 'identity-9', 'provider_bound', 'tg:',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
    for (const forbidden of [
      'externalId', 'providerAccountId', 'providerTargetId', 'transport', 'connectionId', 'sessionId',
      'chatId', 'hasChat', 'conversation', 'route', 'reachab', 'conflict', 'metadata', 'driver', 'fleet',
      'message', 'delivery', 'readiness',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })
})

describe('createSearchContactsHandlerV1', () => {
  it('returns an empty result and touches no database for a refused query', async () => {
    for (const query of ['', ' ', 'и', '12', null, undefined, 42, {}]) {
      const { port, calls } = recordingPort({})
      await expect(createSearchContactsHandlerV1(port)({ query: query as never }))
        .resolves.toEqual({ items: [], total: 0, truncated: false })
      expect(calls).toEqual([])
    }
    const { port, calls } = recordingPort({})
    await expect(createSearchContactsHandlerV1(port)(null)).resolves.toEqual({
      items: [], total: 0, truncated: false,
    })
    expect(calls).toEqual([])
  })

  it('finds a contact by exact phone', async () => {
    const { port, calls } = recordingPort({ ids: { phone_exact: ['contact-1'] } })
    const result = await createSearchContactsHandlerV1(port)({ query: '+7 900 123-45-67' })
    expect(result.items.map(item => item.contactId)).toEqual(['contact-1'])
    expect(result).toMatchObject({ total: 1, truncated: false })
    expect(calls[0]).toEqual({
      kind: 'candidates',
      detail: { criteria: { kind: 'phone', digits: '79001234567' }, rankClass: 'phone_exact', limit: 11 },
    })
  })

  it('falls through to a phone substring when no exact match exists', async () => {
    const { port, calls } = recordingPort({ ids: { phone_substring: ['contact-2'] } })
    const result = await createSearchContactsHandlerV1(port)({ query: '345' })
    expect(result.items.map(item => item.contactId)).toEqual(['contact-2'])
    expect(calls.filter(call => call.kind === 'candidates')).toHaveLength(2)
  })

  it('ranks an exact phone above a substring match, and a prefix above a substring', async () => {
    const exact = recordingPort({
      ids: { phone_exact: ['contact-exact'], phone_substring: ['contact-substring', 'contact-exact'] },
      sources: [
        source({ id: 'contact-exact', displayName: 'Яков Яковлев' }),
        source({ id: 'contact-substring', displayName: 'Абрам Абрамов' }),
      ],
    })
    await expect(createSearchContactsHandlerV1(exact.port)({ query: '79001234567' })
      .then(result => result.items.map(item => item.contactId)))
      .resolves.toEqual(['contact-exact', 'contact-substring'])

    const byName = recordingPort({
      ids: { name_prefix: ['contact-prefix'], name_substring: ['contact-substring', 'contact-prefix'] },
      sources: [
        source({ id: 'contact-prefix', displayName: 'Яков Яковлев' }),
        source({ id: 'contact-substring', displayName: 'Абрам Абрамов' }),
      ],
    })
    await expect(createSearchContactsHandlerV1(byName.port)({ query: 'Иван' })
      .then(result => result.items.map(item => item.contactId)))
      .resolves.toEqual(['contact-prefix', 'contact-substring'])
  })

  it('orders deterministically however the adapter shuffles its rows', async () => {
    const sources = [
      source({ id: 'contact-c', displayName: 'ИВАНОВ Иван' }),
      source({ id: 'contact-a', displayName: 'Иванов Иван' }),
      source({ id: 'contact-b', displayName: 'Абрамов Абрам' }),
    ]
    const expected = ['contact-b', 'contact-a', 'contact-c']
    for (const order of [
      ['contact-a', 'contact-b', 'contact-c'],
      ['contact-c', 'contact-b', 'contact-a'],
      ['contact-b', 'contact-c', 'contact-a'],
    ]) {
      const { port } = recordingPort({ ids: { name_prefix: order }, sources })
      const result = await createSearchContactsHandlerV1(port)({ query: 'Ива' })
      expect(result.items.map(item => item.contactId)).toEqual(expected)
    }
  })

  it('deduplicates a contact id returned by more than one rank class', async () => {
    const { port, calls } = recordingPort({
      ids: { name_prefix: ['contact-1', 'contact-1'], name_substring: ['contact-1'] },
    })
    const result = await createSearchContactsHandlerV1(port)({ query: 'Иван' })
    expect(result.items.map(item => item.contactId)).toEqual(['contact-1'])
    expect(result.total).toBe(1)
    expect((calls.find(call => call.kind === 'sources')?.detail as string[])).toEqual(['contact-1'])
  })

  it('keeps two contacts separate when they share a phone or a name', async () => {
    const shared = recordingPort({
      ids: { phone_exact: ['contact-1', 'contact-2'] },
      sources: [
        source({ id: 'contact-1', displayName: 'Иван Петров' }),
        source({ id: 'contact-2', displayName: 'Иван Петров' }),
      ],
    })
    const result = await createSearchContactsHandlerV1(shared.port)({ query: '79001234567' })
    expect(result.items.map(item => item.contactId)).toEqual(['contact-1', 'contact-2'])
    expect(result.total).toBe(2)
  })

  it('enforces the limit and reports truncation exactly', async () => {
    const ids = Array.from({ length: 12 }, (_unused, index) => `contact-${index}`)
    const sources = ids.map(id => source({ id, displayName: `Контакт ${id}` }))

    const exactlyFull = recordingPort({ ids: { name_prefix: ids.slice(0, 3) }, sources })
    await expect(createSearchContactsHandlerV1(exactlyFull.port)({ query: 'Кон', limit: 3 }))
      .resolves.toMatchObject({ total: 3, truncated: false })

    const overflowing = recordingPort({ ids: { name_prefix: ids.slice(0, 4) }, sources })
    const truncatedResult = await createSearchContactsHandlerV1(overflowing.port)({ query: 'Кон', limit: 3 })
    expect(truncatedResult.items).toHaveLength(3)
    expect(truncatedResult).toMatchObject({ total: 3, truncated: true })

    const clamped = recordingPort({ ids: { name_prefix: ids }, sources })
    const clampedResult = await createSearchContactsHandlerV1(clamped.port)({ query: 'Кон', limit: 1000 })
    expect(clampedResult.items.length).toBeLessThanOrEqual(CONTACT_LOOKUP_MAX_LIMIT_V1)
    expect(clampedResult.truncated).toBe(false)
  })

  it('stops asking for lower rank classes once the budget is filled', async () => {
    const { port, calls } = recordingPort({
      ids: {
        phone_exact: ['contact-1', 'contact-2', 'contact-3'],
        phone_substring: ['contact-4'],
      },
    })
    await createSearchContactsHandlerV1(port)({ query: '79001234567', limit: 2 })
    expect(calls.filter(call => call.kind === 'candidates')).toHaveLength(1)
  })

  it('hydrates once for all candidates and never per row', async () => {
    const ids = ['contact-1', 'contact-2', 'contact-3']
    const { port, calls } = recordingPort({ ids: { name_prefix: ids } })
    await createSearchContactsHandlerV1(port)({ query: 'Кон' })
    const hydrations = calls.filter(call => call.kind === 'sources')
    expect(hydrations).toHaveLength(1)
    expect(hydrations[0].detail).toEqual(ids)
  })

  it('drops a candidate the hydration no longer returns', async () => {
    const port: ContactLookupPortV1 = {
      async findContactLookupCandidateIds() { return ['contact-gone', 'contact-1'] },
      async findContactLookupSources() { return [source({ id: 'contact-1' })] },
    }
    const result = await createSearchContactsHandlerV1(port)({ query: 'Иван' })
    expect(result.items.map(item => item.contactId)).toEqual(['contact-1'])
    expect(result.total).toBe(1)
  })

  it('never emits provider, chat or reachability data for a whole result', async () => {
    const { port } = recordingPort({
      ids: { name_prefix: ['contact-1'] },
      sources: [source({
        id: 'contact-1',
        identities: [{ channel: 'telegram', isActive: true, displayName: `@${PROVIDER_EXTERNAL_ID}` }],
      })],
    })
    const serialized = JSON.stringify(await createSearchContactsHandlerV1(port)({ query: 'Иван' }))
    for (const forbidden of [PROVIDER_EXTERNAL_ID, PROVIDER_ACCOUNT_ID, WHATSAPP_JID]) {
      expect(serialized).not.toContain(forbidden)
    }
    for (const forbidden of ['chatId', 'hasChat', 'reachab', 'conflict', 'externalId', 'transport', 'driver']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })
})
