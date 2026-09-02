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
    displayName: id,
    displayNameSource: 'channel',
    masterSource: 'chat',
    yandexDriverId: null,
    mainDriverId: null,
    mainDriverSelection: 'auto',
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

  test('an unconfirmed park-check snapshot does not turn a channel shell into business state', () => {
    expect(classifyContactForAutomationV1(contact('shell', {
      customFields: {
        parkCheckResult: { checkStatus: 'complete', profiles: [] },
        parkCheckLastAttempt: { checkStatus: 'partial', errors: ['park unavailable'] },
      },
    }))).toMatchObject({ kind: 'channel_only' })
  })

  test.each([
    ['manual display name', { displayNameSource: 'manual' }],
    ['manual master source', { masterSource: 'manual' }],
    ['both manual markers', { displayNameSource: 'manual', masterSource: 'manual' }],
  ])('%s is manually curated substantive identity state', (_label, patch) => {
    expect(classifyContactForAutomationV1(contact('manual', patch))).toEqual({
      kind: 'substantive',
      reasons: ['manually_curated_identity'],
    })
  })

  test.each([
    ['missing display-name source', { displayNameSource: null }],
    ['missing master source', { masterSource: null }],
    ['unrecognized display-name source', { displayNameSource: 'future-provider' }],
    ['unrecognized master source', { masterSource: 'future-provider' }],
  ])('%s fails closed as substantive', (_label, patch) => {
    expect(classifyContactForAutomationV1(contact('unknown', patch))).toEqual({
      kind: 'substantive',
      reasons: ['unknown_identity_source'],
    })
  })

  test.each([
    ['manual pin', { canonicalPinned: true }],
    ['driver confirmation', { confirmedDriver: true }],
    ['legacy driver relationship', { driverRelationshipCount: 1 }],
    ['main Driver selection', { mainDriverId: 'driver-1' }],
    ['manual main Driver mode', { mainDriverSelection: 'manual' }],
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
      confirmedPersonKeys: ['person-1'],
    })).toMatchObject({ decision: 'merge' })
  })

  test('a confirmed physical-driver Contact merges with a credential-free shell on trusted unique phone', () => {
    const confirmedDriver = contact('driver', {
      confirmedDriver: true,
      confirmedPersonKeys: ['person-1'],
    })
    const channelShell = contact('shell')
    expect(evaluateAutomaticContactMergeV1(confirmedDriver, channelShell, phoneEvidence)).toEqual({
      decision: 'merge',
      survivor: expect.objectContaining({ survivorId: 'driver', mergedId: 'shell' }),
      evidenceRoots: [phoneEvidence.phoneEvidenceRoot],
    })
  })

  test('incompatible confirmed keys on both Contacts remain fail-closed', () => {
    const left = contact('A', { confirmedDriver: true, confirmedPersonKeys: ['person-A'] })
    const right = contact('B', { confirmedDriver: true, confirmedPersonKeys: ['person-B'] })
    expect(evaluateAutomaticContactMergeV1(left, right, phoneEvidence)).toEqual({
      decision: 'blocked',
      reason: 'confirmed_person_key_mismatch',
    })
  })

  test('supplied confirmed-person evidence inconsistent with the populated side remains fail-closed', () => {
    const confirmedDriver = contact('driver', {
      confirmedDriver: true,
      confirmedPersonKeys: ['person-A'],
    })
    expect(evaluateAutomaticContactMergeV1(confirmedDriver, contact('shell'), {
      ...phoneEvidence,
      confirmedPersonEvidenceRoots: ['operator-confirmation:person-B'],
      confirmedPersonKeys: ['person-B'],
    })).toEqual({
      decision: 'blocked',
      reason: 'confirmed_person_key_mismatch',
    })
  })

  test('pair-local shared confirmation cannot replace the validated ownership denominator', () => {
    const left = contact('A', { notes: 'left', confirmedPersonKeys: ['person-1'] })
    const right = contact('B', { tags: ['right'], confirmedPersonKeys: ['person-1'] })
    expect(evaluateAutomaticContactMergeV1(left, right, {
      trustedUniqueCurrentPhone: false,
      phoneEvidenceRoot: null,
      confirmedPersonEvidenceRoots: [],
      confirmedPersonKeys: [],
      normalizedVuEvidenceRoots: ['normalized-vu:shared'],
    })).toEqual({ decision: 'blocked', reason: 'confirmed_person_key_mismatch' })
  })

  test('an extra confirmed-person key blocks a merge despite one shared key', () => {
    const left = contact('A', { notes: 'left', confirmedPersonKeys: ['person-X'] })
    const right = contact('B', { tags: ['right'], confirmedPersonKeys: ['person-X', 'person-Y'] })
    expect(evaluateAutomaticContactMergeV1(left, right, {
      ...phoneEvidence,
      confirmedPersonEvidenceRoots: ['operator-confirmation:person-X'],
      confirmedPersonKeys: ['person-X'],
    })).toEqual({ decision: 'blocked', reason: 'confirmed_person_key_mismatch' })
  })

  test('conflicting nonempty notes block an otherwise-valid confirmed-person merge', () => {
    const left = contact('A', { notes: 'left operational note', confirmedPersonKeys: ['person-X'] })
    const right = contact('B', { notes: 'right operational note', confirmedPersonKeys: ['person-X'] })
    expect(evaluateAutomaticContactMergeV1(left, right, {
      ...phoneEvidence,
      confirmedPersonEvidenceRoots: ['operator-confirmation:person-X'],
      confirmedPersonKeys: ['person-X'],
    })).toEqual({ decision: 'blocked', reason: 'business_state_collision' })
  })

  test('a richer nonmanual Contact cannot win and discard a one-sided manual display identity', () => {
    const manualIdentity = contact('manual', {
      displayName: 'Operator curated name',
      displayNameSource: 'manual',
      confirmedPersonKeys: ['person-X'],
    })
    const richerProviderIdentity = contact('provider', {
      displayName: 'Provider name',
      activeTaskCount: 3,
      callCount: 2,
      chatCount: 20,
      messageCount: 100,
      confirmedPersonKeys: ['person-X'],
    })
    expect(evaluateContactSurvivorV1(manualIdentity, richerProviderIdentity)).toMatchObject({
      survivorId: 'provider',
    })
    expect(evaluateAutomaticContactMergeV1(manualIdentity, richerProviderIdentity, {
      ...phoneEvidence,
      confirmedPersonEvidenceRoots: ['operator-confirmation:person-X'],
      confirmedPersonKeys: ['person-X'],
    })).toEqual({ decision: 'blocked', reason: 'business_state_collision' })
  })

  test('differing two-manual names remain a business-state collision', () => {
    const left = contact('A', {
      displayName: 'First curated name',
      displayNameSource: 'manual',
      confirmedPersonKeys: ['person-X'],
    })
    const right = contact('B', {
      displayName: 'Second curated name',
      masterSource: 'manual',
      confirmedPersonKeys: ['person-X'],
    })
    expect(evaluateAutomaticContactMergeV1(left, right, {
      ...phoneEvidence,
      confirmedPersonEvidenceRoots: ['operator-confirmation:person-X'],
      confirmedPersonKeys: ['person-X'],
    })).toEqual({ decision: 'blocked', reason: 'business_state_collision' })
  })

  test('a null overlapping business field cannot overwrite a meaningful value', () => {
    const left = contact('A', {
      customFields: { lifecycleStage: 'qualified' },
      confirmedPersonKeys: ['person-X'],
    })
    const right = contact('B', {
      customFields: { lifecycleStage: null },
      confirmedPersonKeys: ['person-X'],
    })
    expect(evaluateAutomaticContactMergeV1(left, right, {
      ...phoneEvidence,
      confirmedPersonEvidenceRoots: ['operator-confirmation:person-X'],
      confirmedPersonKeys: ['person-X'],
    })).toEqual({ decision: 'blocked', reason: 'business_state_collision' })
  })

  test('distinct main Driver selections collide even on otherwise channel-like Contacts', () => {
    const left = contact('A', { mainDriverId: 'driver-A' })
    const right = contact('B', { mainDriverId: 'driver-B' })
    expect(evaluateAutomaticContactMergeV1(left, right, phoneEvidence)).toEqual({
      decision: 'blocked',
      reason: 'business_state_collision',
    })
  })

  test('circular evidence cannot masquerade as an independent reason', () => {
    const left = contact('A', { notes: 'left', confirmedPersonKeys: ['person-1'] })
    const right = contact('B', { tags: ['right'], confirmedPersonKeys: ['person-1'] })
    expect(evaluateAutomaticContactMergeV1(left, right, {
      ...phoneEvidence,
      confirmedPersonEvidenceRoots: [phoneEvidence.phoneEvidenceRoot],
      confirmedPersonKeys: ['person-1'],
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
