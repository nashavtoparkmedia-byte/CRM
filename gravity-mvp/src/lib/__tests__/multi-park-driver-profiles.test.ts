import { describe, expect, test } from 'vitest'
import { PARK_PRIORITY, chooseMainDriverProfile, getDriverProfileStatus, normalizeParkName } from '../driver-profiles/multi-park'

function profile(id: string, park: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    yandexDriverId: `yd-${id}`,
    fullName: `Driver ${id}`,
    phone: '+79990000000',
    lastExternalPark: park,
    dismissedAt: null,
    hiredAt: new Date('2026-01-01T00:00:00.000Z'),
    lastOrderAt: null,
    ...overrides,
  }
}

describe('multi-park driver profile selection', () => {
  test('park priority contains the six approved parks in order', () => {
    expect(PARK_PRIORITY).toEqual(['Наш Автопарк', 'YOKO', 'YOKO-2', 'YOKO-3', 'YOKO-4', 'YOKO.Доставка'])
    expect(normalizeParkName('yoko доставка')).toBe('YOKO.Доставка')
    expect(normalizeParkName('')).toBe('Парк не указан')
  })

  test('dismissed profiles are preserved but not eligible as main', () => {
    expect(getDriverProfileStatus(profile('old', 'YOKO', { dismissedAt: new Date() }))).toBe('dismissed')
    const decision = chooseMainDriverProfile([
      profile('old', 'YOKO', { dismissedAt: new Date() }),
      profile('active', 'YOKO-2'),
    ])
    expect(decision.main?.id).toBe('active')
  })

  test('main profile follows stable park priority when no manual main is valid', () => {
    const decision = chooseMainDriverProfile([
      profile('delivery', 'YOKO.Доставка'),
      profile('main-park', 'Наш Автопарк'),
      profile('yoko', 'YOKO'),
    ])
    expect(decision.main?.id).toBe('main-park')
    expect(decision.reason).toBe('park_priority')
  })

  test('manual active profile wins when it belongs to a non-anomalous park', () => {
    const decision = chooseMainDriverProfile([
      profile('priority', 'Наш Автопарк'),
      profile('manual', 'YOKO-4'),
    ], 'manual')
    expect(decision.main?.id).toBe('manual')
    expect(decision.reason).toBe('manual')
  })

  test('two active profiles in the same park are reported as anomaly and excluded from auto-main', () => {
    const decision = chooseMainDriverProfile([
      profile('a', 'YOKO'),
      profile('b', 'YOKO'),
      profile('c', 'YOKO-2'),
    ])
    expect(decision.anomalies).toEqual([{ park: 'YOKO', activeCount: 2, driverIds: ['a', 'b'] }])
    expect(decision.main?.id).toBe('c')
  })

  test('manual profile is ignored when its park is anomalous', () => {
    const decision = chooseMainDriverProfile([
      profile('manual', 'YOKO'),
      profile('other-same-park', 'YOKO'),
      profile('fallback', 'YOKO-3'),
    ], 'manual')
    expect(decision.main?.id).toBe('fallback')
    expect(decision.reason).toBe('park_priority')
  })

  test('multiple profiles of the same proven contact are not ambiguous when parks differ', () => {
    const decision = chooseMainDriverProfile([
      profile('main', 'Наш Автопарк'),
      profile('yoko', 'YOKO'),
      profile('delivery', 'YOKO.Доставка', { dismissedAt: new Date('2026-02-01T00:00:00.000Z') }),
    ])
    expect(decision.anomalies).toEqual([])
    expect(decision.main?.id).toBe('main')
  })

  test('no active profiles produces null main without deleting historical profiles', () => {
    const decision = chooseMainDriverProfile([
      profile('old-yoko', 'YOKO', { dismissedAt: new Date('2026-02-01T00:00:00.000Z') }),
      profile('old-yoko2', 'YOKO-2', { dismissedAt: new Date('2026-03-01T00:00:00.000Z') }),
    ])
    expect(decision.main).toBeNull()
    expect(decision.reason).toBe('no_active_profile')
    expect(decision.anomalies).toEqual([])
  })

})
