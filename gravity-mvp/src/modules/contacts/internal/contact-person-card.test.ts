import { describe, expect, it } from 'vitest'
import { CONTACT_PERSON_CARD_QUERY_V1, CONTACT_PERSON_CARD_RESULT_V1 } from '@/contracts/contacts/v1'
import {
  buildContactPersonCardV1,
  createContactPersonCardHandlerV1,
  projectPersonConfirmationV1,
  type ContactPersonCardAuthorityPortV1,
  type ContactPersonCardSourceV1,
} from './contact-person-card'

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-02-01T00:00:00.000Z'
const T2 = '2026-03-01T00:00:00.000Z'

function source(overrides: Partial<ContactPersonCardSourceV1> = {}): ContactPersonCardSourceV1 {
  return {
    id: 'c-1',
    displayName: 'Иванов Иван',
    displayNameSource: 'yandex',
    masterSource: 'yandex',
    primaryPhoneId: 'p-1',
    isArchived: false,
    customFields: {},
    mainDriverId: 'd-1',
    yandexDriverId: 'yd-1',
    phones: [
      { id: 'p-1', phone: '+79990000001', isPrimary: true, isActive: true, verifiedAt: T0 },
      { id: 'p-2', phone: '+79990000002', isPrimary: false, isActive: false, verifiedAt: null },
    ],
    identities: [
      { id: 'i-tg-1', channel: 'telegram', externalId: '1001', displayName: 'ivan', isActive: true, source: 'auto', metadata: { username: 'ivan', providerAccountId: 'legacy', origin: 'provider', conflictState: 'clear' }, phoneId: null, reachabilityStatus: 'confirmed', reachabilityCheckedAt: T1, createdAt: T0 },
      { id: 'i-tg-2', channel: 'telegram', externalId: '1002', displayName: null, isActive: false, source: 'auto', metadata: {}, phoneId: null, reachabilityStatus: 'unknown', reachabilityCheckedAt: null, createdAt: T1 },
      { id: 'i-tg-3', channel: 'telegram', externalId: '1003', displayName: null, isActive: true, source: 'manual', metadata: { providerAliasValues: ['a', 'b'] }, phoneId: 'p-1', reachabilityStatus: 'weird', reachabilityCheckedAt: null, createdAt: T2 },
      { id: 'i-wa-1', channel: 'whatsapp', externalId: '79990000001@c.us', displayName: null, isActive: true, source: 'auto', metadata: {}, phoneId: 'p-1', reachabilityStatus: 'unknown', reachabilityCheckedAt: null, createdAt: T0 },
      { id: 'i-wa-2', channel: 'whatsapp', externalId: '79990000002@c.us', displayName: null, isActive: true, source: 'auto', metadata: {}, phoneId: 'p-2', reachabilityStatus: 'unknown', reachabilityCheckedAt: null, createdAt: T1 },
    ],
    lineage: { canonicalContactId: 'c-1', contactIds: ['c-1', 'c-old'] },
    merges: [
      { id: 'm-1', action: 'merge', reason: 'phone_match', mergedBy: 'system', createdAt: T1, mergedId: 'c-old', survivorId: 'c-1', automated: true, recoveryState: null, recoveredAt: null },
      { id: 'm-0', action: 'unmerge', reason: 'undo', mergedBy: 'admin', createdAt: T0, mergedId: 'c-x', survivorId: 'c-1', automated: null, recoveryState: null, recoveredAt: null },
      { id: 'm-9', action: 'merge', reason: 'manual', mergedBy: 'admin', createdAt: T2, mergedId: 'c-unrelated', survivorId: 'c-other', automated: false, recoveryState: null, recoveredAt: null },
    ],
    policyEvents: [],
    ...overrides,
  }
}

const admin: ContactPersonCardAuthorityPortV1 = {
  async currentPrincipal() { return { kind: 'integration_admin_session' } },
  async mayReadContact() { return true },
}

function handler(src: ContactPersonCardSourceV1 | null, authority: ContactPersonCardAuthorityPortV1 = admin, reads: string[] = []) {
  return createContactPersonCardHandlerV1({
    authority,
    cardSource: { async findContactPersonCardSource(contactId) { reads.push(contactId); return src } },
  })
}

const query = (contactId = 'c-1') => ({ contract: CONTACT_PERSON_CARD_QUERY_V1, contactId })

describe('buildContactPersonCardV1', () => {
  it('lists every account of a channel, active first, and never folds or renames them', () => {
    const card = buildContactPersonCardV1(source())
    expect(card.channels.map(channel => channel.channel)).toEqual(['telegram', 'whatsapp'])
    const telegram = card.channels[0].accounts
    expect(telegram.map(account => [account.identityId, account.isActive])).toEqual([
      ['i-tg-1', true], ['i-tg-3', true], ['i-tg-2', false],
    ])
    expect(telegram[0]).toMatchObject({ externalId: '1001', username: 'ivan', source: 'auto', origin: 'provider', reachabilityStatus: 'confirmed', reachabilityCheckedAt: T1, aliasCount: 0 })
    expect(telegram[1]).toMatchObject({ source: 'manual', reachabilityStatus: 'unknown', aliasCount: 2, linkedPhoneId: 'p-1', origin: 'legacy' })
    expect(card.channels[1].accounts).toHaveLength(2)
  })

  it('keeps the provider id out of the name and marks the second phone superseded only by evidence', () => {
    const card = buildContactPersonCardV1(source({ displayName: 'Контакт TG', displayNameSource: 'channel' }))
    expect(card.displayName).toBe('+7 999 000-00-01')
    expect(card.displayName).not.toMatch(/1001|1002|1003/)
    expect(card.phones.map(phone => [phone.phoneId, phone.isPrimary, phone.lifecycle])).toEqual([
      ['p-1', true, 'current'],
      ['p-2', false, 'removed'],
    ])
    const withEvidence = buildContactPersonCardV1(source({
      customFields: { phoneEvidenceByPhoneId: { 'p-2': { lifecycle: 'superseded', trust: 'provider_bound', resolutionState: 'shared' } } },
    }))
    expect(withEvidence.phones[1]).toMatchObject({ lifecycle: 'superseded', trust: 'provider_bound', resolutionState: 'shared' })
  })

  it('reports lineage and merge history for the lineage only', () => {
    const card = buildContactPersonCardV1(source())
    expect(card.lineage).toMatchObject({ canonicalContactId: 'c-1', contactIds: ['c-1', 'c-old'], mergedFromCount: 1 })
    expect(card.lineage.mergeHistory.map(event => event.mergeId)).toEqual(['m-1', 'm-0'])
    expect(card.lineage.mergeHistory[1].action).toBe('unmerge')
  })

  it('projects conflicts, marks the conflicted account and lists recorded candidates only', () => {
    const card = buildContactPersonCardV1(source({
      customFields: {
        identityConflicts: [
          { id: 'x', status: 'open', conflictType: 'channel_identity_collision', identityId: 'i-tg-1', otherContactId: 'c-2', source: 'channel-ingress', details: { channel: 'telegram', externalUserId: '1001', reason: 'peer_mismatch' }, detectedAt: T1 },
          { id: 'y', status: 'closed', conflictType: 'channel_identity_collision', identityId: 'i-wa-1', otherContactId: 'c-3', detectedAt: T0 },
          { id: 'z', status: 'open', conflictType: 'confirmed_driver_cluster_contradiction', otherContactId: 'c-1', source: 'operator-confirmation', detectedAt: T2 },
        ],
        driverConfirmations: [
          { id: 'k', status: 'needs_reconciliation', profileClusterKey: 'vu:1', representativeDriverId: 'd-1', reconciliationContactId: 'c-4' },
        ],
      },
    }))
    expect(card.hasOpenConflict).toBe(true)
    expect(card.conflicts.filter(conflict => conflict.status === 'open').map(conflict => conflict.otherContactId)).toEqual(['c-2', null])
    expect(card.channels[0].accounts.find(account => account.identityId === 'i-tg-1')?.conflictState).toBe('conflicted')
    expect(card.channels[1].accounts.find(account => account.identityId === 'i-wa-1')?.conflictState).toBe('clear')
    expect(card.candidates).toEqual([
      { contactId: 'c-4', basis: 'needs_reconciliation' },
      { contactId: 'c-2', basis: 'open_conflict' },
    ])
    expect(card.personConfirmation.state).toBe('contradiction')
  })
})

describe('projectPersonConfirmationV1', () => {
  const snapshot = { profiles: [{ driverId: 'd-1', fullName: 'Иванов Иван' }] }
  it('is unconfirmed without a confirmation and confirmed with exactly one', () => {
    expect(projectPersonConfirmationV1({})).toEqual({ state: 'unconfirmed', confirmedPersonName: null, confirmedClusterKeyCount: 0, representativeDriverId: null })
    expect(projectPersonConfirmationV1({ driverConfirmations: [{ status: 'confirmed', profileClusterKey: 'vu:1', representativeDriverId: 'd-1', evidenceSnapshot: snapshot }] }))
      .toEqual({ state: 'confirmed', confirmedPersonName: 'Иванов Иван', confirmedClusterKeyCount: 1, representativeDriverId: 'd-1' })
  })
  it('never names a person while a reconciliation or a contradiction is open', () => {
    expect(projectPersonConfirmationV1({ driverConfirmations: [
      { status: 'confirmed', profileClusterKey: 'vu:1', representativeDriverId: 'd-1', evidenceSnapshot: snapshot },
      { status: 'needs_reconciliation', profileClusterKey: 'vu:2', representativeDriverId: 'd-2' },
    ] })).toMatchObject({ state: 'needs_reconciliation', confirmedPersonName: null, representativeDriverId: null })
    expect(projectPersonConfirmationV1({ driverConfirmations: [{ status: 'contradicted', profileClusterKey: 'vu:1', representativeDriverId: 'd-1' }] }))
      .toMatchObject({ state: 'contradiction', confirmedPersonName: null })
    expect(projectPersonConfirmationV1({
      driverConfirmations: [{ status: 'confirmed', profileClusterKey: 'vu:1', representativeDriverId: 'd-1', evidenceSnapshot: snapshot }],
      identityConflicts: [{ status: 'open', conflictType: 'fleet_authoritative_person_contradiction' }],
    })).toMatchObject({ state: 'contradiction', confirmedPersonName: null })
  })
})

describe('readContactPersonCardV1', () => {
  it('answers forbidden before any read when there is no verified principal', async () => {
    const reads: string[] = []
    const result = await handler(source(), { async currentPrincipal() { return null }, async mayReadContact() { return true } }, reads)(query())
    expect(result).toEqual({ contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'forbidden' })
    expect(reads).toEqual([])
  })

  it('answers forbidden before any read when the principal may not read this Contact', async () => {
    const reads: string[] = []
    const result = await handler(source(), { async currentPrincipal() { return { kind: 'other' } }, async mayReadContact() { return false } }, reads)(query())
    expect(result).toEqual({ contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'forbidden' })
    expect(reads).toEqual([])
  })

  it('carries the ВУ view the authority granted, and the full view only on an explicit grant', async () => {
    const grant = (licenceView?: 'full' | 'last4'): ContactPersonCardAuthorityPortV1 => ({
      async currentPrincipal() { return licenceView === undefined ? { kind: 'staff_session' } : { kind: 'staff_session', licenceView } },
      async mayReadContact() { return true },
    })
    expect(await handler(source(), grant('full'))(query())).toMatchObject({ status: 'confirmed', licenceView: 'full' })
    expect(await handler(source(), grant('last4'))(query())).toMatchObject({ status: 'confirmed', licenceView: 'last4' })
    // A principal without a view, or with an unknown one, never gets the full ВУ.
    expect(await handler(source(), grant())(query())).toMatchObject({ status: 'confirmed', licenceView: 'last4' })
    expect(await handler(source(), grant('everything' as never))(query())).toMatchObject({ status: 'confirmed', licenceView: 'last4' })
  })

  it('refuses a padded id and reads nothing', async () => {
    const reads: string[] = []
    await expect(handler(source(), admin, reads)(query(' c-1'))).rejects.toThrow(/exact/)
    expect(reads).toEqual([])
  })

  it('answers missing for an unknown or archived Contact and refused for a source that is not the asked one', async () => {
    expect(await handler(null)(query())).toEqual({ contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'missing' })
    expect(await handler(source({ isArchived: true }))(query())).toEqual({ contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'missing' })
    expect(await handler(source({ id: 'c-2' }))(query())).toEqual({ contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'refused' })
  })

  it('redirects a merged-away id to its canonical Contact and carries nothing else', async () => {
    const merged = source({
      isArchived: true,
      customFields: { mergedIntoContactId: 'c-9' },
      lineage: { canonicalContactId: 'c-9', contactIds: ['c-1', 'c-9'] },
    })
    expect(await handler(merged)(query())).toEqual({ contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'redirected', canonicalContactId: 'c-9' })
    const broken = source({ customFields: { mergedIntoContactId: 'c-9' }, lineage: null })
    expect(await handler(broken)(query())).toEqual({ contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'redirected', canonicalContactId: 'c-9' })
    const selfLoop = source({ customFields: { mergedIntoContactId: 'c-1' }, lineage: null })
    expect(await handler(selfLoop)(query())).toEqual({ contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'refused' })
  })

  it('confirms the canonical Contact with its card', async () => {
    const result = await handler(source())(query())
    expect(result.status).toBe('confirmed')
    if (result.status !== 'confirmed') throw new Error('unreachable')
    expect(result.card.contactId).toBe('c-1')
    expect(result.card.legacyYandexDriverId).toBe('yd-1')
    expect(result.card.mainDriverId).toBe('d-1')
    expect(result.card.isArchived).toBe(false)
  })
})

describe('the link history (V2 block «История связей»)', () => {
  it('projects only stored records: merges with their manual/auto flag, the phone audit trail, confirmations and policy events', () => {
    const card = buildContactPersonCardV1(source({
      customFields: {
        phoneEvidenceByPhoneId: {
          'p-1': { auditTrail: [
            { id: 'a1', actor: 'identity-access:integration-admin-session', action: 'add_or_verify', afterState: { lifecycle: 'current', isPrimary: false }, beforeState: null, createdAt: '2026-04-01T10:00:00.000Z' },
            { id: 'a2', actor: 'staff:user-7', action: 'set_state', beforeState: { isPrimary: false }, afterState: { lifecycle: 'current', isPrimary: true }, createdAt: '2026-04-02T10:00:00.000Z' },
            { id: 'a3', actor: 'system:provider-confirmation', action: 'attach_identity', afterState: {}, beforeState: {}, createdAt: '2026-04-03T10:00:00.000Z' },
          ] },
          'p-2': { auditTrail: [
            { id: 'a4', actor: 'Иван Петров, не системный', action: 'set_state', beforeState: { lifecycle: 'current' }, afterState: { lifecycle: 'removed' }, createdAt: '2026-04-04T10:00:00.000Z' },
            { id: 'a5', actor: 'staff:user-7', action: 'unknown_action', createdAt: '2026-04-05T10:00:00.000Z' },
            { id: 'a6', actor: 'staff:user-7', action: 'add_or_verify', createdAt: 'not a date' },
          ] },
        },
        driverConfirmations: [
          { id: 'dc1', status: 'confirmed', confirmedBy: 'identity-access:integration-admin-session', confirmedAt: '2026-04-06T10:00:00.000Z', searchInput: 'Иванов', evidenceSnapshot: { secret: 1 } },
        ],
      },
      policyEvents: [
        { eventId: 'e1', cause: 'set', actor: 'staff:user-9', recordedAt: '2026-04-07T10:00:00.000Z', afterDenyAll: false, afterDenyMessage: false, afterDenyVoice: true },
      ],
    }))
    expect(card.linkHistory).toEqual([
      { kind: 'communication_policy_changed', at: '2026-04-07T10:00:00.000Z', subject: null, detail: 'deny_voice', mode: 'manual', actor: { kind: 'staff', userId: 'user-9' } },
      { kind: 'driver_profile_confirmed', at: '2026-04-06T10:00:00.000Z', subject: null, detail: 'confirmed', mode: 'manual', actor: { kind: 'integration_admin' } },
      { kind: 'phone_removed', at: '2026-04-04T10:00:00.000Z', subject: '+79990000002', detail: null, mode: 'unknown', actor: { kind: 'unknown' } },
      { kind: 'identity_attached_to_phone', at: '2026-04-03T10:00:00.000Z', subject: '+79990000001', detail: null, mode: 'automatic', actor: { kind: 'system' } },
      { kind: 'phone_made_primary', at: '2026-04-02T10:00:00.000Z', subject: '+79990000001', detail: null, mode: 'manual', actor: { kind: 'staff', userId: 'user-7' } },
      { kind: 'phone_added_or_verified', at: '2026-04-01T10:00:00.000Z', subject: '+79990000001', detail: null, mode: 'manual', actor: { kind: 'integration_admin' } },
      { kind: 'contacts_merged', at: T1, subject: null, detail: null, mode: 'automatic', actor: { kind: 'unknown' } },
      { kind: 'contacts_unmerged', at: T0, subject: null, detail: null, mode: 'unknown', actor: { kind: 'unknown' } },
    ])
    // No free-text actor, search input or evidence snapshot crosses.
    const serialized = JSON.stringify(card.linkHistory)
    for (const leaked of ['Иван Петров', 'Иванов', 'secret', 'unknown_action']) expect(serialized).not.toContain(leaked)
  })

  it('shows a recovery only when the merge record says it was recovered', () => {
    const card = buildContactPersonCardV1(source({
      merges: [{ id: 'm-r', action: 'merge', reason: 'manual', mergedBy: 'system:auto-merge', createdAt: T1, mergedId: 'c-old', survivorId: 'c-1', automated: true, recoveryState: 'recovered', recoveredAt: T2 }],
    }))
    expect(card.linkHistory.map(event => [event.kind, event.at, event.mode])).toEqual([['merge_recovered', T2, 'unknown'], ['contacts_merged', T1, 'automatic']])
  })

  it('has no events when nothing was recorded, whatever the current state holds', () => {
    const card = buildContactPersonCardV1(source({ merges: [], policyEvents: [] }))
    expect(card.linkHistory).toEqual([])
  })
})

