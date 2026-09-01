import { describe, expect, test } from 'vitest'

import {
  contactAutomationState,
  identityEvidenceState,
  phoneEvidenceState,
  providerAccountMatches,
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

  test('scopes opaque provider identities while preserving conservative legacy compatibility', () => {
    expect(identityEvidenceState({ providerAccountId: 'account-a', origin: 'provider' }))
      .toMatchObject({ providerAccountId: 'account-a', origin: 'provider' })
    expect(providerAccountMatches({ providerAccountId: 'account-a' }, 'account-a')).toBe(true)
    expect(providerAccountMatches({ providerAccountId: 'account-a' }, 'account-b')).toBe(false)
    expect(providerAccountMatches({}, 'account-b')).toBe(true)
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
