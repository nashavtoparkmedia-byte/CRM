import { describe, expect, test } from 'vitest'

import { composeContactCustomFieldsV1 } from './contact-merge-state-composer'

function confirmation(input: {
  id: string
  status: 'confirmed' | 'needs_reconciliation'
  contactId?: string
  root: string
}) {
  return {
    id: input.id,
    profileClusterKey: 'vu:1234567890',
    status: input.status,
    reconciliationContactId: input.contactId ?? null,
    evidenceRoot: input.root,
  }
}

describe('Contact merge custom-field composition', () => {
  test('promotes an exact pending confirmation only when the counterpart is confirmed', () => {
    const composed = composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: {
        driverConfirmations: [confirmation({
          id: 'pending', status: 'needs_reconciliation', contactId: 'target', root: 'operator:source',
        })],
      },
      targetFields: {
        driverConfirmations: [confirmation({ id: 'confirmed', status: 'confirmed', root: 'operator:target' })],
      },
    })

    expect(composed.driverConfirmations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pending', status: 'confirmed' }),
      expect.objectContaining({ id: 'confirmed', status: 'confirmed' }),
    ]))
    expect(composed.confirmedDriverClusterKeys).toEqual(['vu:1234567890'])
  })

  test.each([
    ['no confirmed counterpart', [], 'target'],
    ['pending bound to another Contact', [confirmation({ id: 'confirmed', status: 'confirmed', root: 'operator:target' })], 'third'],
  ])('keeps pending state with %s', (_label, targetConfirmations, reconciliationContactId) => {
    const composed = composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: {
        driverConfirmations: [confirmation({
          id: 'pending', status: 'needs_reconciliation', contactId: reconciliationContactId, root: 'operator:source',
        })],
      },
      targetFields: { driverConfirmations: targetConfirmations },
    })

    expect(composed.driverConfirmations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pending', status: 'needs_reconciliation' }),
    ]))
  })

  test('preserves hard flags, conflicts, phone evidence, and automatic-block audit from both owners', () => {
    const composed = composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: {
        doNotMerge: true,
        phoneEvidenceByPhoneId: { sourcePhone: { evidenceRoot: 'phone:source' } },
        identityConflicts: [{ id: 'conflict-source' }],
        automaticMergeBlocks: [{ id: 'block-source' }],
      },
      targetFields: {
        phoneEvidenceByPhoneId: { targetPhone: { evidenceRoot: 'phone:target' } },
        identityConflicts: [{ id: 'conflict-target' }],
        automaticMergeBlocks: [{ id: 'block-target' }],
      },
    })

    expect(composed).toMatchObject({
      doNotMerge: true,
      phoneEvidenceByPhoneId: {
        sourcePhone: { evidenceRoot: 'phone:source' },
        targetPhone: { evidenceRoot: 'phone:target' },
      },
    })
    expect(composed.identityConflicts).toEqual(expect.arrayContaining([
      { id: 'conflict-source' }, { id: 'conflict-target' },
    ]))
    expect(composed.automaticMergeBlocks).toEqual(expect.arrayContaining([
      { id: 'block-source' }, { id: 'block-target' },
    ]))
  })

  test('does not materialize absent evidence arrays', () => {
    const composed = composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: { retainedSource: true },
      targetFields: { retainedTarget: true },
    })
    expect(composed).toMatchObject({ retainedSource: true, retainedTarget: true })
    expect(composed).not.toHaveProperty('driverConfirmations')
    expect(composed).not.toHaveProperty('identityConflicts')
    expect(composed).not.toHaveProperty('automaticMergeBlocks')
  })

  test('keeps the newest complete park truth and newest attempt independently', () => {
    const newerComplete = { checkStatus: 'complete', checkedAt: '2026-09-02T12:00:00.000Z', marker: 'source-complete' }
    const newerAttempt = { checkStatus: 'partial', checkedAt: '2026-09-02T13:00:00.000Z', marker: 'target-attempt' }
    const composed = composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: {
        parkCheckResult: newerComplete,
        parkCheckLastAttempt: newerComplete,
      },
      targetFields: {
        parkCheckResult: { checkStatus: 'complete', checkedAt: '2026-09-02T10:00:00.000Z', marker: 'target-old' },
        parkCheckLastAttempt: newerAttempt,
      },
    })

    expect(composed.parkCheckResult).toEqual(newerComplete)
    expect(composed.parkCheckLastAttempt).toEqual(newerAttempt)
  })

  test('never promotes a newer partial attempt into the complete park snapshot', () => {
    const lastComplete = { checkStatus: 'complete', checkedAt: '2026-09-01T10:00:00.000Z' }
    const newerPartial = { checkStatus: 'partial', checkedAt: '2026-09-02T10:00:00.000Z' }
    const composed = composeContactCustomFieldsV1({
      sourceContactId: 'source',
      targetContactId: 'target',
      sourceFields: { parkCheckResult: newerPartial },
      targetFields: { parkCheckResult: lastComplete },
    })

    expect(composed.parkCheckResult).toEqual(lastComplete)
  })
})
