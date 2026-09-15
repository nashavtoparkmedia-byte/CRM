import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'

import ContactEvidenceDetails from './ContactEvidenceDetails'
import {
  normalizeParkCheckViewStatus,
  type ContactDriver,
  type ContactIdentity,
  type ContactPhone,
} from '../hooks/useContact'

describe('legacy Park-check view state', () => {
  test('never upgrades a status-less legacy snapshot to complete absence', () => {
    expect(normalizeParkCheckViewStatus({ checkedParks: 2, results: [], errors: [] })).toBe('unknown')
    expect(normalizeParkCheckViewStatus({ checkedParks: 1, results: [], errors: [{ parkId: 'p2' }] })).toBe('partial')
    expect(normalizeParkCheckViewStatus({ checkedParks: 0, results: [], errors: [{ parkId: 'p1' }] })).toBe('failed')
    expect(normalizeParkCheckViewStatus({ checkStatus: 'complete', errors: [] })).toBe('complete')
  })
})

describe('Contact evidence details', () => {
  test('renders every same-provider identity and every park-qualified Driver profile', () => {
    const phones: ContactPhone[] = [{
      id: 'phone-1',
      phone: '+79990000001',
      label: null,
      isPrimary: true,
      source: 'telegram',
    }]
    const identities: ContactIdentity[] = [
      {
        id: 'identity-1', channel: 'telegram', externalId: 'opaque-user-1', phoneId: 'phone-1',
        displayName: 'First', source: 'auto', confidence: 1, reachabilityStatus: 'confirmed',
        reachabilityCheckedAt: '2026-09-01T10:00:00.000Z', providerAccountId: 'bot-a',
        origin: 'provider', evidenceRoot: 'telegram:bot-a:opaque-user-1', conflictState: 'clear',
        isActive: true,
      },
      {
        id: 'identity-2', channel: 'telegram', externalId: 'opaque-user-2', phoneId: null,
        displayName: 'Second', source: 'manual', confidence: 1, reachabilityStatus: 'unknown',
        reachabilityCheckedAt: null, providerAccountId: 'bot-b', origin: 'operator',
        evidenceRoot: 'operator:identity-2', conflictState: 'conflicted', isActive: false,
        conflicts: [{ conflictType: 'provider_account_identity_collision', status: 'open' }],
      },
    ]
    const profiles = [
      {
        id: 'driver-1', fullName: 'Иванов Иван', phone: '+79990000001', segment: 'active', score: null,
        lastOrderAt: null, hiredAt: null, dismissedAt: null, externalParkId: 'park-a',
        externalDriverProfileId: 'profile-a', licenseNumber: '12 34 567890', normalizedVu: '1234567890',
        legalRole: 'driver', workStatus: 'working', currentStatus: 'online', sourceStatus: 'online',
        sourceFreshness: 'fresh', sourceState: 'current',
        sourceDates: { modifiedDate: '2026-09-01' },
        park: { id: 'local-a', parkName: 'Парк А', externalParkId: 'park-a' },
      },
      {
        id: 'driver-2', fullName: 'Иванов Иван', phone: '+79990000002', segment: 'active', score: null,
        lastOrderAt: null, hiredAt: null, dismissedAt: null, externalParkId: 'park-b',
        externalDriverProfileId: 'profile-b', licenseNumber: '1234567890', normalizedVu: '1234567890',
        legalRole: 'courier', workStatus: 'dismissed', currentStatus: 'offline', sourceStatus: 'offline',
        sourceFreshness: 'stale', sourceState: 'stale',
        park: { id: 'local-b', parkName: 'Парк Б', externalParkId: 'park-b' },
      },
    ] satisfies ContactDriver[]

    const html = renderToStaticMarkup(
      <ContactEvidenceDetails identities={identities} phones={phones} profiles={profiles} />,
    )

    for (const evidence of [
      'opaque-user-1', 'opaque-user-2', 'bot-a', 'bot-b',
      'telegram:bot-a:opaque-user-1', 'provider_account_identity_collision',
      'Парк А', 'Парк Б', 'profile-a', 'profile-b', '1234567890',
      'working', 'online', 'dismissed', 'offline', 'fresh', 'stale',
    ]) {
      expect(html).toContain(evidence)
    }
  })
})
