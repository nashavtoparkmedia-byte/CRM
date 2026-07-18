import { describe, expect, test } from 'vitest'

import { mapStrictPhoneOwnership } from '@/lib/contacts/strict-phone-ownership'
import type { ContactResolutionResult } from '@/lib/contacts/contact-resolution.types'

const warnings: ContactResolutionResult['warnings'] = []

describe('strict phone ownership result mapping', () => {
  test('zero canonical owners is not_found', () => {
    expect(mapStrictPhoneOwnership({ status: 'create_required', warnings }))
      .toEqual({ kind: 'not_found' })
  })

  test('one canonical owner is matched', () => {
    expect(mapStrictPhoneOwnership({
      status: 'phone_matched',
      contactId: 'raw',
      canonicalContactId: 'canonical',
      warnings,
    })).toEqual({ kind: 'matched', contactId: 'canonical' })
  })

  test('a merge chain resolves to its one canonical owner', () => {
    expect(mapStrictPhoneOwnership({
      status: 'merged_contact',
      originalContactId: 'archived',
      canonicalContactId: 'survivor',
      warnings,
    })).toEqual({ kind: 'matched', contactId: 'survivor' })
  })

  test('two or more owners is ambiguous and deterministic', () => {
    expect(mapStrictPhoneOwnership({
      status: 'ambiguous_phone',
      candidateContactIds: ['contact-b', 'contact-a', 'contact-b'],
      warnings,
    })).toEqual({
      kind: 'ambiguous',
      contactIds: ['contact-a', 'contact-b'],
      reason: 'ambiguous_phone',
    })
  })

  test.each([
    { status: 'merge_cycle', contactIds: ['B', 'A'], warnings },
    { status: 'merge_ambiguous', contactIds: ['B', 'A'], warnings },
    { status: 'merge_depth_exceeded', contactIds: ['B', 'A'], warnings },
  ] as const)('unsafe canonical chain $status is ambiguous', result => {
    expect(mapStrictPhoneOwnership(result)).toMatchObject({
      kind: 'ambiguous',
      contactIds: ['A', 'B'],
      reason: result.status,
    })
  })

  test('archived owner without a survivor is ambiguous', () => {
    expect(mapStrictPhoneOwnership({
      status: 'archived_without_merge',
      contactId: 'archived',
      warnings,
    })).toEqual({
      kind: 'ambiguous',
      contactIds: ['archived'],
      reason: 'archived_without_merge',
    })
  })
})
