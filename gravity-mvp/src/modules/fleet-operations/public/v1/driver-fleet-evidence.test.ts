import { describe, expect, test } from 'vitest'

import { driverFleetEvidenceState, withDriverFleetEvidence } from './driver-fleet-evidence'

describe('Driver Fleet JSON evidence compatibility', () => {
  test('round-trips source profile provenance and preserves unrelated Driver fields', () => {
    const customFields = withDriverFleetEvidence({ retained: true }, {
      legalRole: 'driver',
      sourceStatus: 'working',
      sourceCity: 'Москва',
      sourceProfileType: 'self_employed',
      sourcePhones: ['+79990000000'],
      sourceDates: { modifiedDate: '2026-09-01' },
      lastObservedAt: '2026-09-01T00:00:00.000Z',
      lastSynchronizedAt: '2026-09-01T00:01:00.000Z',
      sourceFreshness: 'fresh',
      sourceState: 'current',
      sourceMetadata: { licenseHistory: [{ normalizedValue: '7712345678' }] },
    })

    expect(customFields.retained).toBe(true)
    expect(driverFleetEvidenceState(customFields)).toMatchObject({
      legalRole: 'driver',
      sourcePhones: ['+79990000000'],
      sourceFreshness: 'fresh',
      sourceState: 'current',
    })
  })

  test('unknown legacy provenance is explicit and non-current', () => {
    expect(driverFleetEvidenceState(null)).toMatchObject({
      sourceFreshness: 'unknown',
      sourceState: 'unknown',
      sourcePhones: [],
    })
  })
})
