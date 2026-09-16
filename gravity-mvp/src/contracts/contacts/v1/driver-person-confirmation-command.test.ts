import { describe, expect, test } from 'vitest'

import {
  CONFIRM_DRIVER_PERSON_COMMAND_V1,
  DriverPersonCommandValidationError,
  parseConfirmDriverPersonCommandV1,
  parseReconcileDriverClusterCommandV1,
  RECONCILE_DRIVER_CLUSTER_COMMAND_V1,
} from './driver-person-confirmation-command'

const profile = {
  driverId: 'driver-1',
  externalParkId: 'park-1',
  externalDriverProfileId: 'profile-1',
  fullName: 'Иванов Иван',
  phones: ['+79990000001'],
  normalizedVu: '1234567890',
  evidenceRoot: 'yandex:park-1:profile-1:observation-1',
  sourceFreshness: 'fresh' as const,
  legalRole: 'driver',
  status: 'working',
  sourceDates: { createdDate: '2025-01-01', modifiedDate: null },
}

const confirmation = {
  contract: CONFIRM_DRIVER_PERSON_COMMAND_V1,
  contactId: 'contact-1',
  profileClusterKey: 'vu:1234567890',
  representativeDriverId: 'driver-1',
  confirmedBy: 'operator-1',
  confirmationBasis: 'vu' as const,
  searchInput: '1234567890',
  evidenceSnapshot: { profiles: [profile], warnings: [] },
}

describe('Driver person command contracts', () => {
  test('accepts the exact v1 confirmation and reconciliation envelopes', () => {
    expect(parseConfirmDriverPersonCommandV1(confirmation)).toEqual(confirmation)
    const reconcile = {
      contract: RECONCILE_DRIVER_CLUSTER_COMMAND_V1,
      profileClusterKey: confirmation.profileClusterKey,
      profiles: [profile],
    }
    expect(parseReconcileDriverClusterCommandV1(reconcile)).toEqual(reconcile)
  })

  test.each([
    ['top-level field', { ...confirmation, surprise: true }],
    ['snapshot field', { ...confirmation, evidenceSnapshot: { ...confirmation.evidenceSnapshot, surprise: true } }],
    ['profile field', {
      ...confirmation,
      evidenceSnapshot: { profiles: [{ ...profile, surprise: true }], warnings: [] },
    }],
    ['array enum coercion', { ...confirmation, confirmationBasis: ['vu'] }],
    ['array freshness coercion', {
      ...confirmation,
      evidenceSnapshot: { profiles: [{ ...profile, sourceFreshness: ['fresh'] }], warnings: [] },
    }],
    ['non-string phone', {
      ...confirmation,
      evidenceSnapshot: { profiles: [{ ...profile, phones: [79990000001] }], warnings: [] },
    }],
    ['nested date object', {
      ...confirmation,
      evidenceSnapshot: { profiles: [{ ...profile, sourceDates: { createdDate: {} } }], warnings: [] },
    }],
    ['Date in place of source date record', {
      ...confirmation,
      evidenceSnapshot: { profiles: [{ ...profile, sourceDates: new Date() }], warnings: [] },
    }],
    ['Map in place of source date record', {
      ...confirmation,
      evidenceSnapshot: { profiles: [{ ...profile, sourceDates: new Map() }], warnings: [] },
    }],
    ['empty authoritative evidence', {
      ...confirmation,
      evidenceSnapshot: { profiles: [], warnings: [] },
    }],
    ['stale authoritative evidence', {
      ...confirmation,
      evidenceSnapshot: { profiles: [{ ...profile, sourceFreshness: 'stale' }], warnings: [] },
    }],
    ['representative outside the evidence cluster', {
      ...confirmation,
      representativeDriverId: 'forged-driver',
    }],
    ['cluster key outside the supplied evidence', {
      ...confirmation,
      profileClusterKey: 'vu:forged-cluster',
    }],
  ])('rejects an invalid %s before owner logic', (_label, command) => {
    expect(() => parseConfirmDriverPersonCommandV1(command)).toThrow(DriverPersonCommandValidationError)
  })

  test('distinguishes an unsupported confirmation version', () => {
    try {
      parseConfirmDriverPersonCommandV1({ ...confirmation, contract: 'contacts.ConfirmDriverPersonCommand.v2' })
      throw new Error('expected parser failure')
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNSUPPORTED_CONTRACT_VERSION' })
    }
  })

  test('rejects unknown fields and unsupported versions on reconciliation too', () => {
    expect(() => parseReconcileDriverClusterCommandV1({
      contract: RECONCILE_DRIVER_CLUSTER_COMMAND_V1,
      profileClusterKey: 'vu:1234567890',
      profiles: [profile],
      unknown: true,
    })).toThrow(DriverPersonCommandValidationError)
    expect(() => parseReconcileDriverClusterCommandV1({
      contract: 'contacts.ReconcileDriverClusterCommand.v2',
      profileClusterKey: 'vu:1234567890',
      profiles: [profile],
    })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_CONTRACT_VERSION' }))
  })
})
