/**
 * contacts.ContactMergePreviewQuery.v1 answers exactly the survivor the merge's
 * own policy picks over the two Contacts, never the order the page asked in, and
 * refuses pairs the merge would refuse.
 */
import { describe, expect, it } from 'vitest'
import { CONTACT_MERGE_PREVIEW_QUERY_V1 } from '@/contracts/contacts/v1'
import type { ContactMergeSourceV1 } from '../public/v1/contact-merge-handler'
import { createContactMergePreviewHandlerV1 } from './contact-merge-preview'

function contact(id: string, overrides: Partial<ContactMergeSourceV1> = {}): ContactMergeSourceV1 {
  return {
    id, createdAt: new Date('2026-01-01T00:00:00.000Z'), displayName: id, displayNameSource: 'manual', masterSource: 'manual',
    yandexDriverId: null, mainDriverId: null, mainDriverSelection: null, canonicalPinnedAt: null, doNotMerge: false, isArchived: false,
    notes: null, tags: [], customFields: {}, phones: [], identities: [], chats: [], tasks: [], calls: [], driverProfiles: [], driverConfirmations: [],
    ...overrides,
  } as unknown as ContactMergeSourceV1
}

const query = (sourceContactId: string, targetContactId: string) => ({ contract: CONTACT_MERGE_PREVIEW_QUERY_V1, sourceContactId, targetContactId })

describe('previewContactMergeV1', () => {
  it('names the survivor by the merge policy, whichever card asks', async () => {
    const pinned = contact('c-pinned', { canonicalPinnedAt: new Date('2026-02-01T00:00:00.000Z') } as never)
    const other = contact('c-other')
    const preview = createContactMergePreviewHandlerV1(async (s, t) => ({ source: s === 'c-pinned' ? pinned : other, target: t === 'c-pinned' ? pinned : other }))
    for (const [source, target] of [['c-pinned', 'c-other'], ['c-other', 'c-pinned']]) {
      const answer = await preview(query(source, target))
      expect(answer).toMatchObject({ status: 'previewed', survivorContactId: 'c-pinned', mergedContactId: 'c-other' })
      // The decisive reason comes first; later reasons the policy also compared follow.
      expect(answer.status === 'previewed' ? answer.reasons[0] : null).toBe('manual_canonical_pin')
    }
  })

  it('falls back to the older Contact, then the id, as the policy does', async () => {
    const older = contact('c-b', { createdAt: new Date('2025-01-01T00:00:00.000Z') } as never)
    const newer = contact('c-a', { createdAt: new Date('2026-01-01T00:00:00.000Z') } as never)
    const preview = createContactMergePreviewHandlerV1(async () => ({ source: newer, target: older }))
    await expect(preview(query('c-a', 'c-b'))).resolves.toMatchObject({ survivorContactId: 'c-b', reasons: ['older_contact', 'immutable_id'] })
  })

  it('refuses the pairs the merge refuses, without reading for the same id', async () => {
    let reads = 0
    const preview = (source: ContactMergeSourceV1 | null, target: ContactMergeSourceV1 | null) =>
      createContactMergePreviewHandlerV1(async () => { reads += 1; return { source, target } })
    await expect(preview(contact('a'), contact('b'))(query('a', 'a'))).resolves.toMatchObject({ status: 'unavailable', reason: 'same_contact' })
    expect(reads).toBe(0)
    await expect(preview(null, contact('b'))(query('a', 'b'))).resolves.toMatchObject({ status: 'unavailable', reason: 'missing' })
    await expect(preview(contact('a', { isArchived: true } as never), contact('b'))(query('a', 'b'))).resolves.toMatchObject({ status: 'unavailable', reason: 'archived' })
    await expect(preview(contact('a'), contact('b', { doNotMerge: true } as never))(query('a', 'b'))).resolves.toMatchObject({ status: 'unavailable', reason: 'merge_forbidden' })
  })

  it('rejects a malformed query before any read', async () => {
    let reads = 0
    const preview = createContactMergePreviewHandlerV1(async () => { reads += 1; return { source: null, target: null } })
    for (const bad of [{}, query('a', ''), query(' a', 'b'), { ...query('a', 'b'), extra: 1 }, { ...query('a', 'b'), contract: 'x' }]) {
      await expect(preview(bad)).rejects.toThrow()
    }
    expect(reads).toBe(0)
  })
})
