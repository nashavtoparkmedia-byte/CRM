import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  createReconcileYandexFleetHandlerV1,
  makeParkQualifiedDriverKeyV1,
  canAdoptUnqualifiedLegacyDriverProfileV1,
  normalizeDriverLicenceVuV1,
  registerYandexFleetReconciliationRunnerV1,
  requireYandexFleetReconciliationRunnerV1,
  yandexFleetProfileObservationV1,
} from './yandex-fleet-reconciler'
import {
  RECONCILE_YANDEX_FLEET_COMMAND_V1,
  ReconcileYandexFleetCommandValidationError,
} from '@/contracts/fleet-operations/v1'

afterEach(() => {
  globalThis.__yandexFleetReconciliationRunnerV1 = undefined
})

describe('Fleet reconciliation runtime composition', () => {
  test('fails closed while the Platform Shell runner is unconfigured', () => {
    expect(() => requireYandexFleetReconciliationRunnerV1())
      .toThrow('YANDEX_FLEET_RECONCILIATION_RUNNER_NOT_REGISTERED')
  })

  test('registers idempotently for one stable runner and rejects replacement', () => {
    const runner = vi.fn()
    const competingRunner = vi.fn()
    const unregister = registerYandexFleetReconciliationRunnerV1(runner)

    expect(requireYandexFleetReconciliationRunnerV1()).toBe(runner)
    expect(() => registerYandexFleetReconciliationRunnerV1(runner)).not.toThrow()
    expect(() => registerYandexFleetReconciliationRunnerV1(competingRunner))
      .toThrow('YANDEX_FLEET_RECONCILIATION_RUNNER_ALREADY_REGISTERED')

    unregister()
    expect(() => requireYandexFleetReconciliationRunnerV1())
      .toThrow('YANDEX_FLEET_RECONCILIATION_RUNNER_NOT_REGISTERED')
  })
})

describe('Fleet profile identity and VU evidence', () => {
  test.each([
    ['12 34-567890', '1234567890'],
    ['AB 123456', 'AB123456'],
    ['АБ 123456', 'АБ123456'],
  ])('normalizes conservative valid source value %s', (raw, expected) => {
    expect(normalizeDriverLicenceVuV1(raw)).toBe(expected)
  })

  test.each(['', '12345', 'name-only', 'AА123456', '12/34/567890'])('rejects invalid or ambiguous value %s', raw => {
    expect(normalizeDriverLicenceVuV1(raw)).toBeNull()
  })

  test('park/profile composite is stable and park-qualified', () => {
    expect(makeParkQualifiedDriverKeyV1('park-a', 'profile-1'))
      .toBe(makeParkQualifiedDriverKeyV1('park-a', 'profile-1'))
    expect(makeParkQualifiedDriverKeyV1('park-a', 'profile-1'))
      .not.toBe(makeParkQualifiedDriverKeyV1('park-b', 'profile-1'))
  })

  test('never lets the first of several parks claim an unqualified legacy provider id', () => {
    expect(canAdoptUnqualifiedLegacyDriverProfileV1(1)).toBe(true)
    expect(canAdoptUnqualifiedLegacyDriverProfileV1(2)).toBe(false)
    expect(canAdoptUnqualifiedLegacyDriverProfileV1(6)).toBe(false)
  })

  test('preserves raw profile metadata while producing normalized comparison evidence', () => {
    const observedAt = new Date('2026-09-01T12:00:00.000Z')
    const observation = yandexFleetProfileObservationV1('park-a', 'local-a', 'connection-a', {
      driver_profile: {
        id: 'profile-1', last_name: 'Иванов', first_name: 'Иван', middle_name: 'Иванович',
        phones: ['8 (999) 000-00-00'], driver_license: { number: '12 34-567890' },
        legal_role: 'driver', work_status: 'working', city: 'Москва', profile_type: 'staff',
        created_date: '2024-01-01', modified_date: '2026-09-01',
      },
      current_status: { status: 'online', status_updated_at: '2026-09-01T11:00:00Z' },
    }, observedAt)
    expect(observation).toMatchObject({
      externalParkId: 'park-a', externalDriverProfileId: 'profile-1',
      fullName: 'Иванов Иван Иванович', phones: ['+79990000000'],
      rawVu: '12 34-567890', normalizedVu: '1234567890', legalRole: 'driver',
      workStatus: 'working', currentStatus: 'online', city: 'Москва', profileType: 'staff',
    })
    expect(observation?.rawMetadata).toHaveProperty('driverProfile')
  })
})

describe('Fleet reconciliation command boundary', () => {
  test('uses the fleet_operations namespace and passes an exact v1 command to the port', async () => {
    expect(RECONCILE_YANDEX_FLEET_COMMAND_V1)
      .toBe('fleet_operations.ReconcileYandexFleetCommand.v1')
    const result = {
      mode: 'manual' as const,
      checkedParks: 0,
      succeededParks: 0,
      failedParks: 0,
      profilesObserved: 0,
      profilesUpserted: 0,
      clusters: [],
      errors: [],
      partial: false,
    }
    const port = { reconcile: vi.fn().mockResolvedValue(result) }
    const command = { contract: RECONCILE_YANDEX_FLEET_COMMAND_V1, mode: 'manual' as const, query: 'Ivanov' }
    await expect(createReconcileYandexFleetHandlerV1(port)(command)).resolves.toEqual(result)
    expect(port.reconcile).toHaveBeenCalledWith(command)
  })

  test.each([
    ['legacy namespace', { contract: 'fleet.ReconcileYandexFleetCommand.v1', mode: 'manual' }],
    ['unknown field', { contract: RECONCILE_YANDEX_FLEET_COMMAND_V1, mode: 'manual', extra: true }],
    ['coerced mode', { contract: RECONCILE_YANDEX_FLEET_COMMAND_V1, mode: ['manual'] }],
    ['non-string query', { contract: RECONCILE_YANDEX_FLEET_COMMAND_V1, mode: 'manual', query: 42 }],
  ])('rejects %s without invoking the Fleet port', async (_label, command) => {
    const port = { reconcile: vi.fn() }
    await expect(createReconcileYandexFleetHandlerV1(port)(command))
      .rejects.toBeInstanceOf(ReconcileYandexFleetCommandValidationError)
    expect(port.reconcile).not.toHaveBeenCalled()
  })

  test('distinguishes an unsupported fleet_operations version', async () => {
    const port = { reconcile: vi.fn() }
    await expect(createReconcileYandexFleetHandlerV1(port)({
      contract: 'fleet_operations.ReconcileYandexFleetCommand.v2',
      mode: 'manual',
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTRACT_VERSION' })
    expect(port.reconcile).not.toHaveBeenCalled()
  })
})
