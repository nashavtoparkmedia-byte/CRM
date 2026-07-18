import { readFileSync } from 'fs'
import path from 'path'

import { describe, expect, test } from 'vitest'

import { planMergedContactState } from '../contact-merge-state'

function contact(overrides: Partial<Parameters<typeof planMergedContactState>[0]['source']> = {}) {
  return {
    id: 'contact',
    mainDriverId: null,
    mainDriverSelection: 'auto',
    primaryPhoneId: null,
    profileIds: [],
    phones: [],
    tags: [],
    notes: null,
    customFields: {},
    ...overrides,
  }
}

describe('manual Contact merge state', () => {
  test('keeps the survivor main profile instead of silently replacing it', () => {
    const result = planMergedContactState({
      source: contact({ id: 'source', mainDriverId: 'source-driver', mainDriverSelection: 'manual', profileIds: ['source-driver'] }),
      target: contact({ id: 'target', mainDriverId: 'target-driver', mainDriverSelection: 'manual', profileIds: ['target-driver'] }),
    })
    expect(result.mainDriverId).toBe('target-driver')
    expect(result.mainDriverSelection).toBe('manual')
  })

  test('preserves a valid source main profile when the survivor has none', () => {
    const result = planMergedContactState({
      source: contact({ id: 'source', mainDriverId: 'source-driver', mainDriverSelection: 'manual', profileIds: ['source-driver'] }),
      target: contact({ id: 'target' }),
    })
    expect(result).toMatchObject({ mainDriverId: 'source-driver', mainDriverSelection: 'manual' })
  })

  test('never leaves a main profile id that is not attached to either Contact', () => {
    const result = planMergedContactState({
      source: contact({ id: 'source', mainDriverId: 'missing-source-profile' }),
      target: contact({ id: 'target', mainDriverId: 'missing-target-profile' }),
    })
    expect(result.mainDriverId).toBeNull()
  })

  test('keeps the target primary phone and clears the moved source primary flag', () => {
    const result = planMergedContactState({
      source: contact({ id: 'source', primaryPhoneId: 'source-phone', phones: [{ id: 'source-phone', isPrimary: true }] }),
      target: contact({ id: 'target', primaryPhoneId: 'target-phone', phones: [{ id: 'target-phone', isPrimary: true }] }),
    })
    expect(result).toMatchObject({ primaryPhoneId: 'target-phone', clearSourcePrimary: true })
  })

  test('adopts the source primary phone only when the survivor has none', () => {
    const result = planMergedContactState({
      source: contact({ id: 'source', primaryPhoneId: 'source-phone', phones: [{ id: 'source-phone', isPrimary: true }] }),
      target: contact({ id: 'target' }),
    })
    expect(result).toMatchObject({ primaryPhoneId: 'source-phone', clearSourcePrimary: false })
  })

  test('preserves both tag sets, source-only fields and notes without overwriting the survivor', () => {
    const result = planMergedContactState({
      source: contact({ id: 'source', tags: ['source', 'shared'], notes: 'source note', customFields: { sourceOnly: 'yes', shared: 'source' } }),
      target: contact({ id: 'target', tags: ['target', 'shared'], notes: 'target note', customFields: { targetOnly: 'yes', shared: 'target' } }),
    })
    expect(result.tags).toEqual(['shared', 'source', 'target'])
    expect(result.notes).toContain('target note')
    expect(result.notes).toContain('source note')
    expect(result.customFields).toEqual({ sourceOnly: 'yes', targetOnly: 'yes', shared: 'target' })
  })
})

describe('ContactMerge executor safety contract', () => {
  test('requires signed preview, locks explicit Contact ids and moves the full direct graph', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/lib/ContactMergeService.ts'), 'utf8')
    const route = readFileSync(path.join(process.cwd(), 'src/app/api/contacts/[id]/merge-to/[targetId]/route.ts'), 'utf8')

    expect(route).toContain('export async function GET')
    expect(route).toContain('previewContactMerge')
    expect(route).toContain('getCurrentUser')
    expect(route).toContain('confirmationToken')
    expect(route).not.toContain('body.mergedBy')
    expect(route).not.toContain('mergedBy =')

    expect(source).toContain('WHERE id IN (${lockIds[0]}, ${lockIds[1]})')
    expect(source).toContain('FOR UPDATE')
    expect(source).toContain('pg_advisory_xact_lock')
    expect(source).toContain('TransactionIsolationLevel.Serializable')
    expect(source).toContain('verifyContactMergeConfirmationToken')
    expect(source).toContain('STALE_MERGE_PLAN')
    expect(source).toContain('tx.call.updateMany')
    expect(source).toContain('tx.contactDriverProfileAudit.updateMany')
    expect(source).toContain('tx.contactIdentity.updateMany')
    expect(source).toContain('tx.contactPhone.updateMany')
    expect(source).toContain('tx.chat.updateMany')
    expect(source).toContain('tx.task.updateMany')
    expect(source).toContain('tx.driver.updateMany')
    expect(source).toContain("telegramBindings: 'retained_via_driver_profile'")
    expect(source).toContain("messages: 'transitive_via_chat'")
    expect(source).toContain("attachments: 'transitive_via_message'")
    expect(source).toContain("mode: 'operator_manifest'")
    expect(source).toContain('mergeRecordId: merge.id')
    expect(source).toContain('contactMerge.create')
    expect(source).not.toContain('findFirst({ where: { phone')
    expect(source).not.toContain('findFirst({ where: { fullName')
  })
})
