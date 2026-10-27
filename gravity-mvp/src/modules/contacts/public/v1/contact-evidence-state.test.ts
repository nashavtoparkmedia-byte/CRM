import { describe, expect, test } from 'vitest'

import {
  confirmedPersonNameV1,
  contactAutomationState,
  identityEvidenceState,
  phoneEvidenceState,
  withPhoneEvidence,
} from './contact-evidence-state'

describe('Contact JSON evidence compatibility', () => {
  test('legacy phone rows fail closed for destructive automatic resolution', () => {
    const evidence = phoneEvidenceState(null, 'phone-1', {
      phone: '+79990000000',
      isActive: true,
      verifiedAt: null,
    })

    expect(evidence).toMatchObject({
      lifecycle: 'current',
      trust: 'unknown',
      freshness: 'unknown',
      resolutionState: 'unknown',
    })
  })

  test('round-trips per-phone provenance without replacing unrelated Contact fields', () => {
    const stored = withPhoneEvidence({ leadStage: 'active' }, 'phone-1', {
      rawPhone: '8 999 000-00-00',
      lifecycle: 'current',
      trust: 'manually_verified',
      freshness: 'fresh',
      resolutionState: 'unique',
      verifiedBy: 'operator-1',
      verificationBasis: 'passport check',
      observedAt: '2026-09-01T00:00:00.000Z',
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      lifecycleUpdatedAt: '2026-09-01T00:00:00.000Z',
      evidenceRoot: 'manual:operator-1',
      auditTrail: [{ action: 'add_or_verify' }],
    })

    expect(stored.leadStage).toBe('active')
    expect(phoneEvidenceState(stored, 'phone-1', {
      phone: '+79990000000', isActive: true, verifiedAt: null,
    })).toMatchObject({
      rawPhone: '8 999 000-00-00',
      trust: 'manually_verified',
      verifiedBy: 'operator-1',
    })
  })

  test('reads provider account provenance as telemetry, defaulting an absent stamp', () => {
    expect(identityEvidenceState({ providerAccountId: 'account-a', origin: 'provider' }))
      .toMatchObject({ providerAccountId: 'account-a', origin: 'provider' })
    // An absent stamp reads back as the legacy sentinel. It is descriptive
    // metadata only: no runtime authorization compares these values, because
    // provider-account isolation is deferred until a provider-authoritative
    // account identity exists. See docs/design/provider-account-identity-v1.md.
    expect(identityEvidenceState({}).providerAccountId).toBe('legacy')
    expect(identityEvidenceState({ providerAccountId: '  ' }).providerAccountId).toBe('legacy')
  })

  test('reads merge redirect, recovery, canonical pin and do-not-merge from existing JSON', () => {
    expect(contactAutomationState({
      canonicalPinnedAt: '2026-09-01T00:00:00.000Z',
      canonicalPinnedBy: 'operator-1',
      doNotMerge: true,
      mergedIntoContactId: 'survivor',
      mergeRecoveryState: 'recoverable',
    })).toEqual({
      canonicalPinnedAt: '2026-09-01T00:00:00.000Z',
      canonicalPinnedBy: 'operator-1',
      doNotMerge: true,
      mergedIntoContactId: 'survivor',
      mergeRecoveryState: 'recoverable',
    })
  })
})

/** A snapshot profile in the exact shape the confirmation writer persists. */
function snapshotProfile(driverId: string, overrides: Record<string, unknown> = {}) {
  return {
    driverId,
    fullName: 'Иван Петров',
    externalParkId: 'park-1',
    externalDriverProfileId: `profile-${driverId}`,
    evidenceRoot: `yandex:park-1:profile-${driverId}`,
    sourceFreshness: 'fresh',
    phones: ['79990000000'],
    ...overrides,
  }
}

/** A stored confirmation record, modern and complete unless overridden. */
function storedConfirmation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'confirmation-1',
    profileClusterKey: 'vu:7700123456',
    representativeDriverId: 'driver-a',
    status: 'confirmed',
    confirmedBy: 'operator-1',
    confirmationBasis: 'operator_confirmation',
    searchInput: '7700123456',
    evidenceRoot: 'yandex:park-1:profile-driver-a',
    evidenceSnapshot: { profiles: [snapshotProfile('driver-a')], warnings: [] },
    confirmedAt: '2026-09-01T00:00:00.000Z',
    lastReconciledAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('confirmed person name evidence', () => {
  test('reads the representative name from one valid confirmation', () => {
    expect(confirmedPersonNameV1({ driverConfirmations: [storedConfirmation()] })).toBe('Иван Петров')
  })

  test('ignores every other Contact field and needs no Driver relationship', () => {
    // mainDriverId is deliberately absent here and is never consulted: it gates
    // Driver-facing writes, not this display read.
    expect(confirmedPersonNameV1({
      leadStage: 'active',
      confirmedDriverClusterKeys: ['vu:7700123456'],
      driverConfirmations: [storedConfirmation()],
    })).toBe('Иван Петров')
  })

  test('fails closed on a Contact with no confirmation evidence at all', () => {
    expect(confirmedPersonNameV1(null)).toBeNull()
    expect(confirmedPersonNameV1(undefined)).toBeNull()
    expect(confirmedPersonNameV1('not an object')).toBeNull()
    expect(confirmedPersonNameV1([storedConfirmation()])).toBeNull()
    expect(confirmedPersonNameV1({})).toBeNull()
    expect(confirmedPersonNameV1({ driverConfirmations: null })).toBeNull()
    expect(confirmedPersonNameV1({ driverConfirmations: 'confirmed' })).toBeNull()
    expect(confirmedPersonNameV1({ driverConfirmations: [] })).toBeNull()
    expect(confirmedPersonNameV1({ driverConfirmations: [null, 'x', 7] })).toBeNull()
  })

  test('fails closed on a legacy record with no evidence snapshot', () => {
    const { evidenceSnapshot: _omitted, ...legacy } = storedConfirmation()
    expect(confirmedPersonNameV1({ driverConfirmations: [legacy] })).toBeNull()
  })

  test('fails closed on a malformed evidence snapshot', () => {
    for (const evidenceSnapshot of [null, 'snapshot', 7, [], [{ profiles: [] }]]) {
      expect(confirmedPersonNameV1({
        driverConfirmations: [storedConfirmation({ evidenceSnapshot })],
      })).toBeNull()
    }
  })

  test('fails closed when profiles is absent or not an array', () => {
    for (const profiles of [undefined, null, 'profiles', {}, 3]) {
      expect(confirmedPersonNameV1({
        driverConfirmations: [storedConfirmation({ evidenceSnapshot: { profiles, warnings: [] } })],
      })).toBeNull()
    }
    // An empty profile list is storable although the write validator forbids it.
    expect(confirmedPersonNameV1({
      driverConfirmations: [storedConfirmation({ evidenceSnapshot: { profiles: [], warnings: [] } })],
    })).toBeNull()
  })

  test('fails closed when the snapshot does not contain the confirmed representative', () => {
    expect(confirmedPersonNameV1({
      driverConfirmations: [storedConfirmation({
        evidenceSnapshot: { profiles: [snapshotProfile('driver-b')], warnings: [] },
      })],
    })).toBeNull()
  })

  test('fails closed when the representative profile carries no usable name', () => {
    for (const fullName of [undefined, null, '', '   ', '\t\n', 42, { value: 'Иван' }]) {
      expect(confirmedPersonNameV1({
        driverConfirmations: [storedConfirmation({
          evidenceSnapshot: { profiles: [snapshotProfile('driver-a', { fullName })], warnings: [] },
        })],
      })).toBeNull()
    }
  })

  test('fails closed on an unbounded name', () => {
    expect(confirmedPersonNameV1({
      driverConfirmations: [storedConfirmation({
        evidenceSnapshot: { profiles: [snapshotProfile('driver-a', { fullName: 'И'.repeat(200) })], warnings: [] },
      })],
    })).toBe('И'.repeat(200))
    expect(confirmedPersonNameV1({
      driverConfirmations: [storedConfirmation({
        evidenceSnapshot: { profiles: [snapshotProfile('driver-a', { fullName: 'И'.repeat(201) })], warnings: [] },
      })],
    })).toBeNull()
  })

  test('fails closed on ASCII control characters in a scraped name', () => {
    for (const fullName of ['Иван\u0000Петров', 'Иван\u001FПетров', 'Иван\u007FПетров', 'Иван\u0007']) {
      expect(confirmedPersonNameV1({
        driverConfirmations: [storedConfirmation({
          evidenceSnapshot: { profiles: [snapshotProfile('driver-a', { fullName })], warnings: [] },
        })],
      })).toBeNull()
    }
    // Ordinary whitespace is trimmed, not rejected.
    expect(confirmedPersonNameV1({
      driverConfirmations: [storedConfirmation({
        evidenceSnapshot: { profiles: [snapshotProfile('driver-a', { fullName: '  Иван Петров\n' })], warnings: [] },
      })],
    })).toBe('Иван Петров')
  })

  test('accepts several representative profiles that agree after trimming', () => {
    expect(confirmedPersonNameV1({
      driverConfirmations: [storedConfirmation({
        evidenceSnapshot: {
          profiles: [
            snapshotProfile('driver-a', { fullName: 'Иван Петров', externalParkId: 'park-1' }),
            snapshotProfile('driver-a', { fullName: ' Иван Петров ', externalParkId: 'park-2' }),
          ],
          warnings: [],
        },
      })],
    })).toBe('Иван Петров')
  })

  test('fails closed when the representative name disagrees with itself', () => {
    expect(confirmedPersonNameV1({
      driverConfirmations: [storedConfirmation({
        evidenceSnapshot: {
          profiles: [
            snapshotProfile('driver-a', { fullName: 'Иван Петров' }),
            snapshotProfile('driver-a', { fullName: 'Иван Петрович' }),
          ],
          warnings: [],
        },
      })],
    })).toBeNull()
  })

  test('ignores cluster profiles that belong to other drivers', () => {
    expect(confirmedPersonNameV1({
      driverConfirmations: [storedConfirmation({
        evidenceSnapshot: {
          profiles: [
            snapshotProfile('driver-b', { fullName: 'Петров И. И.' }),
            snapshotProfile('driver-a', { fullName: 'Иван Петров' }),
            snapshotProfile('driver-c', { fullName: 'ПЕТРОВ ИВАН' }),
          ],
          warnings: [],
        },
      })],
    })).toBe('Иван Петров')
  })

  test('fails closed while any reconciliation is pending', () => {
    expect(confirmedPersonNameV1({
      driverConfirmations: [
        storedConfirmation(),
        storedConfirmation({
          id: 'confirmation-2',
          status: 'needs_reconciliation',
          profileClusterKey: 'vu:7700999999',
          reconciliationContactId: 'other-contact',
        }),
      ],
    })).toBeNull()
  })

  test('treats contradicted and revoked records as no evidence', () => {
    for (const status of ['contradicted', 'revoked', 'confirmed_elsewhere', '']) {
      expect(confirmedPersonNameV1({
        driverConfirmations: [storedConfirmation({ status })],
      })).toBeNull()
    }
  })

  test('keeps a valid confirmation beside a stale contradicted record for the same person', () => {
    expect(confirmedPersonNameV1({
      driverConfirmations: [
        storedConfirmation({ id: 'confirmation-old', status: 'contradicted' }),
        storedConfirmation({ id: 'confirmation-new' }),
      ],
    })).toBe('Иван Петров')
  })

  test('fails closed on two confirmed representatives, and never picks one', () => {
    expect(confirmedPersonNameV1({
      driverConfirmations: [
        storedConfirmation(),
        storedConfirmation({
          id: 'confirmation-2',
          representativeDriverId: 'driver-z',
          profileClusterKey: 'vu:7700999999',
          evidenceSnapshot: { profiles: [snapshotProfile('driver-z', { fullName: 'Пётр Сидоров' })], warnings: [] },
        }),
      ],
    })).toBeNull()
  })

  test('accepts repeated confirmations of the same representative', () => {
    expect(confirmedPersonNameV1({
      driverConfirmations: [
        storedConfirmation({ id: 'confirmation-1' }),
        storedConfirmation({ id: 'confirmation-2', confirmedAt: '2026-09-10T00:00:00.000Z' }),
      ],
    })).toBe('Иван Петров')
  })

  test('fails closed on a confirmed record whose representative is unusable', () => {
    for (const representativeDriverId of [undefined, null, '', '   ', ' driver-a ', 7]) {
      expect(confirmedPersonNameV1({
        driverConfirmations: [storedConfirmation({ representativeDriverId })],
      })).toBeNull()
    }
  })

  test('fails closed while a confirmed-driver cluster contradiction is open', () => {
    expect(confirmedPersonNameV1({
      driverConfirmations: [storedConfirmation()],
      identityConflicts: [{
        id: 'conflict-1',
        conflictType: 'confirmed_driver_cluster_contradiction',
        status: 'open',
      }],
    })).toBeNull()
  })

  test('fails closed while a fleet authoritative person contradiction is open', () => {
    expect(confirmedPersonNameV1({
      driverConfirmations: [storedConfirmation()],
      identityConflicts: [{
        id: 'conflict-1',
        conflictType: 'fleet_authoritative_person_contradiction',
        status: 'open',
      }],
    })).toBeNull()
  })

  test('is not suppressed by resolved person conflicts or by unrelated open ones', () => {
    for (const status of ['resolved', 'closed', 'superseded']) {
      expect(confirmedPersonNameV1({
        driverConfirmations: [storedConfirmation()],
        identityConflicts: [{ conflictType: 'confirmed_driver_cluster_contradiction', status }],
      })).toBe('Иван Петров')
    }
    expect(confirmedPersonNameV1({
      driverConfirmations: [storedConfirmation()],
      identityConflicts: [{ conflictType: 'channel_identity_collision', status: 'open' }],
    })).toBe('Иван Петров')
    expect(confirmedPersonNameV1({
      driverConfirmations: [storedConfirmation()],
      identityConflicts: 'not an array',
    })).toBe('Иван Петров')
  })

  test('does not treat snapshot freshness as a live time-to-live', () => {
    // The snapshot records a human decision. A profile that has since gone
    // stale in the fleet does not expire the operator's confirmation, and only
    // an explicit revocation or contradiction removes the name.
    expect(confirmedPersonNameV1({
      driverConfirmations: [storedConfirmation({
        confirmedAt: '2024-01-01T00:00:00.000Z',
        lastReconciledAt: '2024-01-01T00:00:00.000Z',
        evidenceSnapshot: {
          profiles: [snapshotProfile('driver-a', { sourceFreshness: 'stale' })],
          warnings: ['profile_stale'],
        },
      })],
    })).toBe('Иван Петров')
  })
})
