import { describe, expect, test } from 'vitest'

import {
  classifyContactForAutomationV1,
  evaluateAutomaticContactMergeV1,
  evaluateContactSurvivorV1,
  type ContactAutomationSnapshotV1,
} from './contact-automation-policy'

function contact(id: string, patch: Partial<ContactAutomationSnapshotV1> = {}): ContactAutomationSnapshotV1 {
  return {
    id,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    canonicalPinned: false,
    doNotMerge: false,
    isArchived: false,
    notes: null,
    tags: [],
    customFields: null,
    manualIdentityCount: 0,
    driverRelationshipCount: 0,
    activeTaskCount: 0,
    callCount: 0,
    chatCount: 1,
    messageCount: 10,
    confirmedDriver: false,
    confirmedPersonKeys: [],
    workflowKeys: [],
    openConflictTypes: [],
    ...patch,
  }
}

const phoneEvidence = {
  trustedUniqueCurrentPhone: true,
  phoneEvidenceRoot: 'provider-phone:+79990000000',
  confirmedPersonEvidenceRoots: [],
  normalizedVuEvidenceRoots: [],
}

describe('Contacts automation decision matrix', () => {
  test('provider communication history alone remains channel-only', () => {
    expect(classifyContactForAutomationV1(contact('shell'))).toMatchObject({ kind: 'channel_only' })
  })

  test('provider phone evidence is not mistaken for independent business state', () => {
    expect(classifyContactForAutomationV1(contact('shell', {
      customFields: {
        phoneEvidenceByPhoneId: { p1: { trust: 'provider_bound', evidenceRoot: 'provider:p1' } },
      },
    }))).toMatchObject({ kind: 'channel_only' })
  })

  test.each([
    ['manual pin', { canonicalPinned: true }],
    ['driver confirmation', { confirmedDriver: true }],
    ['legacy driver relationship', { driverRelationshipCount: 1 }],
    ['manual identity', { manualIdentityCount: 1 }],
    ['work', { activeTaskCount: 1 }],
    ['call', { callCount: 1 }],
    ['notes', { notes: 'operator note' }],
    ['tags', { tags: ['vip'] }],
    ['business fields', { customFields: { stage: 'lead' } }],
    ['conflict', { openConflictTypes: ['shared_phone'] }],
  ])('%s makes a Contact substantive', (_label, patch) => {
    expect(classifyContactForAutomationV1(contact('contact', patch))).toMatchObject({ kind: 'substantive' })
  })

  test.each([
    ['shell + shell', contact('A'), contact('B'), 'merge'],
    ['shell + substantive', contact('A'), contact('B', { notes: 'curated' }), 'merge'],
    [
      'substantive + substantive on phone only',
      contact('A', { notes: 'left' }),
      contact('B', { tags: ['right'] }),
      'blocked',
    ],
    [
      'two legacy Driver-linked Contacts on phone only',
      contact('A', { driverRelationshipCount: 1 }),
      contact('B', { driverRelationshipCount: 1 }),
      'blocked',
    ],
  ])('%s follows the frozen policy', (_label, left, right, expected) => {
    expect(evaluateAutomaticContactMergeV1(left, right, phoneEvidence).decision).toBe(expected)
  })

  test('independent same-person confirmation permits substantive merge', () => {
    const left = contact('A', { notes: 'left', confirmedPersonKeys: ['person-1'] })
    const right = contact('B', { tags: ['right'], confirmedPersonKeys: ['person-1'] })
    expect(evaluateAutomaticContactMergeV1(left, right, {
      ...phoneEvidence,
      confirmedPersonEvidenceRoots: ['operator-confirmation:person-1'],
    })).toMatchObject({ decision: 'merge' })
  })

  test('circular evidence cannot masquerade as an independent reason', () => {
    const left = contact('A', { notes: 'left', confirmedPersonKeys: ['person-1'] })
    const right = contact('B', { tags: ['right'], confirmedPersonKeys: ['person-1'] })
    expect(evaluateAutomaticContactMergeV1(left, right, {
      ...phoneEvidence,
      confirmedPersonEvidenceRoots: [phoneEvidence.phoneEvidenceRoot],
    })).toMatchObject({ decision: 'blocked', reason: 'substantive_phone_only' })
  })

  test.each([
    ['do-not-merge', contact('A', { doNotMerge: true }), contact('B'), 'do_not_merge'],
    ['hard conflict', contact('A', { openConflictTypes: ['disputed_phone'] }), contact('B'), 'hard_conflict'],
    [
      'workflow collision',
      contact('A', { workflowKeys: ['task:active:a'] }),
      contact('B', { workflowKeys: ['task:active:b'] }),
      'workflow_collision',
    ],
  ])('%s fails closed', (_label, left, right, reason) => {
    expect(evaluateAutomaticContactMergeV1(left, right, phoneEvidence)).toEqual({ decision: 'blocked', reason })
  })
})

describe('deterministic survivor ordering', () => {
  test.each([
    ['manual canonical pin', { canonicalPinned: true }, {}, 'A'],
    ['substantive over shell', { notes: 'curated' }, {}, 'A'],
    ['more workflows', { workflowKeys: ['one', 'two'] }, { workflowKeys: ['one'] }, 'A'],
    ['richer history', { callCount: 3 }, { callCount: 1 }, 'A'],
    ['confirmed driver tie-break', { confirmedDriver: true }, { notes: 'substantive' }, 'A'],
    [
      'older contact',
      { createdAt: new Date('2024-01-01T00:00:00.000Z') },
      { createdAt: new Date('2025-01-01T00:00:00.000Z') },
      'A',
    ],
    ['immutable id', {}, {}, 'A'],
  ])('%s', (_label, leftPatch, rightPatch, survivorId) => {
    expect(evaluateContactSurvivorV1(contact('A', leftPatch), contact('B', rightPatch)))
      .toMatchObject({ survivorId })
  })

  test('a Driver-linked Contact is not unconditionally survivor', () => {
    const driver = contact('driver', { confirmedDriver: true })
    const richer = contact('crm', { notes: 'curated', activeTaskCount: 2, callCount: 3 })
    expect(evaluateContactSurvivorV1(driver, richer)).toMatchObject({ survivorId: 'crm' })
  })
})
