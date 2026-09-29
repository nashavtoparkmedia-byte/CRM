/**
 * ContactCardSummary.v1 proven as a pure projection.
 *
 * The point of these tests is not that the fields are copied, but that the
 * contract stays provider-neutral: whatever the source rows contain, no provider
 * external id, no ProviderAccount id, no conversation and no driver datum can
 * reach the summary, and the canonical title comes from the display policy
 * rather than from a rule reimplemented here.
 */
import { describe, expect, it } from 'vitest'

import {
  buildContactCardSummaryV1,
  createContactCardSummaryHandlerV1,
  type ContactCardSummarySourceV1,
} from './contact-card-summary'
import { buildCanonicalContactSummary } from './contact-display-policy'
import { confirmedPersonNameV1 } from './contact-evidence-state'

const EXTERNAL_ID = '902100000001'
const PROVIDER_ACCOUNT_ID = 'tg-bot-7712345678'

function source(overrides: Partial<ContactCardSummarySourceV1> = {}): ContactCardSummarySourceV1 {
  return {
    id: 'contact-1',
    displayName: 'Иван Петров',
    displayNameSource: 'manual',
    masterSource: 'chat',
    primaryPhoneId: 'phone-1',
    customFields: {},
    phones: [{ id: 'phone-1', phone: '79001234567', isPrimary: true, isActive: true, lifecycle: 'current' }],
    identities: [{ channel: 'telegram', isActive: true, metadata: {} }],
    mergedFromCount: 0,
    ...overrides,
  }
}

describe('buildContactCardSummaryV1', () => {
  it('projects a minimal contact', () => {
    const summary = buildContactCardSummaryV1(source())
    expect(summary).toEqual({
      contactId: 'contact-1',
      displayName: 'Иван Петров',
      displayTitle: 'Иван Петров · +7 900 123-45-67',
      primaryPhone: '+7 900 123-45-67',
      phoneCount: 1,
      channels: [{ channel: 'telegram', identityCount: 1, hasActiveIdentity: true, conflictState: 'clear' }],
      hasIdentityConflict: false,
      source: 'chat',
      lineage: { mergedFromCount: 0 },
    })
  })

  it('exposes exactly the declared field set', () => {
    expect(Object.keys(buildContactCardSummaryV1(source())).sort()).toEqual([
      'channels',
      'contactId',
      'displayName',
      'displayTitle',
      'hasIdentityConflict',
      'lineage',
      'phoneCount',
      'primaryPhone',
      'source',
    ])
  })

  it('reuses the canonical display policy rather than a local rule', () => {
    const input = source({ displayName: 'Контакт MAX', displayNameSource: 'channel' })
    const canonical = buildCanonicalContactSummary({
      contact: {
        displayName: input.displayName,
        displayNameSource: input.displayNameSource,
        primaryPhoneId: input.primaryPhoneId,
        canonicalPinnedAt: null,
        phones: input.phones,
        identities: input.identities,
      },
      driver: null,
      currentChannel: null,
    })
    const summary = buildContactCardSummaryV1(input)
    // A technical provider name must not become the title: that decision lives
    // in the policy, and the summary must agree with it exactly.
    expect(summary.displayName).toBe(canonical.displayName)
    expect(summary.displayTitle).toBe(canonical.displayTitle)
    expect(summary.primaryPhone).toBe(canonical.primaryPhone)
    expect(summary.displayName).not.toBe('Контакт MAX')
  })

  it('honours a pinned canonical name from Contacts-owned state', () => {
    const summary = buildContactCardSummaryV1(source({
      displayName: 'Пётр Сидоров',
      displayNameSource: 'channel',
      customFields: { canonicalPinnedAt: '2026-09-01T00:00:00.000Z' },
    }))
    expect(summary.displayName).toBe('Пётр Сидоров')
  })

  it('aggregates several identities per channel', () => {
    const summary = buildContactCardSummaryV1(source({
      identities: [
        { channel: 'telegram', isActive: true, metadata: {} },
        { channel: 'telegram', isActive: false, metadata: {} },
        { channel: 'max', isActive: false, metadata: {} },
        { channel: 'whatsapp', isActive: true, metadata: {} },
      ],
    }))
    expect(summary.channels).toEqual([
      { channel: 'max', identityCount: 1, hasActiveIdentity: false, conflictState: 'clear' },
      { channel: 'telegram', identityCount: 2, hasActiveIdentity: true, conflictState: 'clear' },
      { channel: 'whatsapp', identityCount: 1, hasActiveIdentity: true, conflictState: 'clear' },
    ])
  })

  it('reports a conflicted channel and the contact-level flag', () => {
    const summary = buildContactCardSummaryV1(source({
      identities: [
        { channel: 'telegram', isActive: true, metadata: { conflictState: 'conflicted' } },
        { channel: 'telegram', isActive: true, metadata: {} },
        { channel: 'max', isActive: true, metadata: {} },
      ],
    }))
    expect(summary.channels[1]).toEqual({
      channel: 'telegram', identityCount: 2, hasActiveIdentity: true, conflictState: 'conflicted',
    })
    expect(summary.channels[0].conflictState).toBe('clear')
    expect(summary.hasIdentityConflict).toBe(true)
  })

  it('counts only phones that still exist for the contact', () => {
    const summary = buildContactCardSummaryV1(source({
      phones: [
        { id: 'phone-1', phone: '79001234567', isActive: true, lifecycle: 'current' },
        { id: 'phone-2', phone: '79007654321', isActive: true, lifecycle: 'superseded' },
        { id: 'phone-3', phone: '79009999999', isActive: false, lifecycle: 'removed' },
        { id: 'phone-4', phone: '79008888888', isActive: false },
      ],
    }))
    expect(summary.phoneCount).toBe(2)
  })

  it('projects source and lineage', () => {
    const summary = buildContactCardSummaryV1(source({ masterSource: 'yandex', mergedFromCount: 3 }))
    expect(summary.source).toBe('yandex')
    expect(summary.lineage).toEqual({ mergedFromCount: 3 })
    expect(buildContactCardSummaryV1(source({ mergedFromCount: -2 as never })).lineage.mergedFromCount).toBe(0)
  })

  it('survives an empty contact', () => {
    const summary = buildContactCardSummaryV1(source({
      displayName: 'Контакт',
      displayNameSource: 'channel',
      primaryPhoneId: null,
      phones: [],
      identities: [],
    }))
    expect(summary.channels).toEqual([])
    expect(summary.primaryPhone).toBeNull()
    expect(summary.phoneCount).toBe(0)
    expect(summary.hasIdentityConflict).toBe(false)
  })

  it('never carries a provider id, an account id or foreign-domain state', () => {
    const summary = buildContactCardSummaryV1(source({
      identities: [{
        channel: 'telegram',
        isActive: true,
        displayName: '@ivan',
        metadata: {
          providerAccountId: PROVIDER_ACCOUNT_ID,
          username: 'ivan',
          externalId: EXTERNAL_ID,
          transportRef: 'max-personal-0123456789abcdef01234567',
        },
      }],
    }))
    const serialized = JSON.stringify(summary)
    for (const forbidden of [EXTERNAL_ID, PROVIDER_ACCOUNT_ID, 'max-personal-', '@ivan', 'username']) {
      expect(serialized).not.toContain(forbidden)
    }
    for (const forbidden of ['chatId', 'conversation', 'delivery', 'driver', 'task', 'reachab', 'readiness', 'externalId']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })
})

/** The Contacts-owned confirmation evidence exactly as the adapter reads it. */
function confirmedPersonCustomFields(overrides: Record<string, unknown> = {}) {
  return {
    driverConfirmations: [{
      id: 'confirmation-1',
      profileClusterKey: 'vu:7700123456',
      representativeDriverId: 'driver-a',
      status: 'confirmed',
      confirmedBy: 'operator-1',
      confirmationBasis: 'operator_confirmation',
      evidenceRoot: 'yandex:park-1:profile-driver-a',
      evidenceSnapshot: {
        profiles: [{
          driverId: 'driver-a',
          fullName: 'Иван Петров',
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
    ...overrides,
  }
}

describe('confirmed person name in the card summary', () => {
  it('titles the card with the confirmed person instead of a channel name', () => {
    // This is the exact composition the persistence adapter performs: the
    // accessor reads the contact's own customFields and the display policy
    // decides. Nothing about a Driver row is involved.
    const customFields = confirmedPersonCustomFields()
    const summary = buildContactCardSummaryV1(source({
      displayName: 'Контакт MAX',
      displayNameSource: 'channel',
      customFields,
      confirmedPersonName: confirmedPersonNameV1(customFields),
    }))
    expect(summary.displayName).toBe('Иван Петров')
    expect(summary.displayTitle).toBe('Иван Петров · +7 900 123-45-67')
  })

  it('keeps a manually pinned canonical name above the confirmed person name', () => {
    const customFields = confirmedPersonCustomFields({ canonicalPinnedAt: '2026-09-02T00:00:00.000Z' })
    const summary = buildContactCardSummaryV1(source({
      displayName: 'Пётр Сидоров',
      displayNameSource: 'channel',
      customFields,
      confirmedPersonName: confirmedPersonNameV1(customFields),
    }))
    expect(summary.displayName).toBe('Пётр Сидоров')
  })

  it('lets the display policy reject a technical confirmed name and fall through', () => {
    // The accessor validates structure only; deciding that "Контакт MAX" is not
    // a person stays with ContactDisplayPolicy.
    const summary = buildContactCardSummaryV1(source({
      displayName: 'Иван из чата',
      displayNameSource: 'channel',
      confirmedPersonName: 'Контакт MAX',
    }))
    expect(summary.displayName).toBe('Иван из чата')
    expect(buildContactCardSummaryV1(source({
      displayName: 'Контакт MAX',
      displayNameSource: 'channel',
      confirmedPersonName: '79001234567',
    })).displayName).toBe('+7 900 123-45-67')
  })

  it('falls back to the ordinary cascade when the evidence is ambiguous', () => {
    const customFields = confirmedPersonCustomFields({
      identityConflicts: [{ conflictType: 'confirmed_driver_cluster_contradiction', status: 'open' }],
    })
    expect(confirmedPersonNameV1(customFields)).toBeNull()
    const summary = buildContactCardSummaryV1(source({
      displayName: 'Иван из чата',
      displayNameSource: 'channel',
      customFields,
      confirmedPersonName: confirmedPersonNameV1(customFields),
    }))
    expect(summary.displayName).toBe('Иван из чата')
  })

  it('keeps the declared field set and leaks no confirmation evidence', () => {
    const customFields = confirmedPersonCustomFields()
    const summary = buildContactCardSummaryV1(source({
      customFields,
      confirmedPersonName: confirmedPersonNameV1(customFields),
    }))
    expect(Object.keys(summary).sort()).toEqual([
      'channels',
      'contactId',
      'displayName',
      'displayTitle',
      'hasIdentityConflict',
      'lineage',
      'phoneCount',
      'primaryPhone',
      'source',
    ])
    const serialized = JSON.stringify(summary)
    for (const forbidden of [
      'driver-a', 'representativeDriverId', 'evidenceSnapshot', 'profileClusterKey',
      'confirmationBasis', 'evidenceRoot', 'park-1', 'profile-driver-a', 'confirmedPersonName',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
    for (const forbidden of ['driver', 'fleet', 'park', 'confirmation']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })
})

describe('createContactCardSummaryHandlerV1', () => {
  it('reads through its port and projects the result', async () => {
    const calls: string[] = []
    const read = createContactCardSummaryHandlerV1({
      async findContactCardSummarySource(contactId) {
        calls.push(contactId)
        return source({ id: contactId })
      },
    })
    await expect(read('contact-7')).resolves.toMatchObject({ contactId: 'contact-7' })
    expect(calls).toEqual(['contact-7'])
  })

  it('returns null for an unknown contact and never calls the port for a blank id', async () => {
    let calls = 0
    const read = createContactCardSummaryHandlerV1({
      async findContactCardSummarySource() { calls += 1; return null },
    })
    await expect(read('missing')).resolves.toBeNull()
    await expect(read('   ')).resolves.toBeNull()
    await expect(read('' as never)).resolves.toBeNull()
    expect(calls).toBe(1)
  })
})
