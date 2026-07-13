import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { APPROVED_PARKS, type SourceDriverProfile } from '../driver-profiles/park-identity'
import { InMemoryNightlySyncLock } from '../driver-profiles/nightly-sync'
import {
  buildDriverProfileMutation,
  DatabaseNightlySyncLock,
  runProductionDriverProfileSync,
  sourceOnlyYandexDriverId,
} from '../driver-profiles/production-sync'

function profile(overrides: Partial<SourceDriverProfile> = {}): SourceDriverProfile {
  return {
    externalParkId: APPROVED_PARKS[0].externalParkId,
    externalDriverProfileId: 'driver-1',
    parkCode: APPROVED_PARKS[0].parkCode,
    parkName: APPROVED_PARKS[0].parkName,
    phone: '+7 922 215-57-50',
    fullName: 'Иванов Иван',
    employmentType: 'selfemployed',
    sourceWorkStatus: 'working',
    sourceCurrentStatus: 'free',
    sourceUpdatedAt: '2026-07-13T10:00:00.000Z',
    fetchedAt: '2026-07-13T10:05:00.000Z',
    ...overrides,
  }
}

function existing(overrides: Record<string, unknown> = {}) {
  return {
    id: 'db-driver-1',
    yandexDriverId: 'legacy-driver-1',
    externalParkId: APPROVED_PARKS[0].externalParkId,
    externalDriverProfileId: 'driver-1',
    parkId: 'park-db-1',
    sourceConnectionId: 'api-1',
    fullName: 'Иванов Иван',
    phone: '+79222155750',
    lastExternalPark: APPROVED_PARKS[0].parkName,
    statusOverride: 'working',
    lastFleetCheckStatus: 'free',
    lastFleetCheckAt: new Date('2026-07-13T10:00:00.000Z'),
    dismissedAt: null,
    customFields: {
      yandexProfile: {
        employmentType: 'selfemployed',
        sourceUpdatedAt: '2026-07-13T10:00:00.000Z',
        sourceWorkStatus: 'working',
        sourceCurrentStatus: 'free',
      },
    },
    contactId: 'contact-1',
    ...overrides,
  }
}

describe('production composite DriverProfile sync', () => {
  test('same external id and phone in different parks produce different composite keys', () => {
    const first = buildDriverProfileMutation({ profile: profile(), parkId: 'park-db-1', sourceConnectionId: 'api-1' })
    const secondPark = APPROVED_PARKS[1]
    const second = buildDriverProfileMutation({
      profile: profile({ externalParkId: secondPark.externalParkId, parkCode: secondPark.parkCode, parkName: secondPark.parkName }),
      parkId: 'park-db-2',
      sourceConnectionId: 'api-2',
    })
    expect(first.where).not.toEqual(second.where)
    expect(first.create.phone).toBe(second.create.phone)
    expect(first.create).not.toHaveProperty('contactId')
    expect(second.create).not.toHaveProperty('contactId')
    expect(sourceOnlyYandexDriverId(profile())).toContain(`${APPROVED_PARKS[0].externalParkId}:driver-1`)
  })

  test('repeated identical source is unchanged and never rewrites Contact attachment', () => {
    const mutation = buildDriverProfileMutation({ profile: profile(), parkId: 'park-db-1', sourceConnectionId: 'api-1', existing: existing() })
    expect(mutation.changed).toBe(false)
    expect(mutation.update).not.toHaveProperty('contactId')
  })

  test('phone and status changes update the same profile while preserving Contact ownership', () => {
    const mutation = buildDriverProfileMutation({
      profile: profile({ phone: '+7 999 000-00-01', sourceWorkStatus: 'dismissed', sourceCurrentStatus: 'fired' }),
      parkId: 'park-db-1',
      sourceConnectionId: 'api-1',
      existing: existing(),
    })
    expect(mutation.where).toEqual({ externalParkId_externalDriverProfileId: { externalParkId: APPROVED_PARKS[0].externalParkId, externalDriverProfileId: 'driver-1' } })
    expect(mutation.update).toMatchObject({ phone: '+79990000001', statusOverride: 'dismissed' })
    expect(mutation.update).not.toHaveProperty('contactId')
    expect(mutation.statusChanged).toBe(true)
  })

  test('DB-backed lease is atomic, owner-guarded, and stale-safe', async () => {
    const query = vi.fn().mockResolvedValueOnce([{ locked: true }]).mockResolvedValueOnce([])
    const execute = vi.fn().mockResolvedValue(1)
    const db = { $queryRawUnsafe: query, $executeRawUnsafe: execute }
    const first = new DatabaseNightlySyncLock(db as never, () => 'owner-a', 1234)
    const second = new DatabaseNightlySyncLock(db as never, () => 'owner-b', 1234)
    expect(await first.acquire('driver-profiles:nightly-full-sync')).toBe(true)
    expect(await second.acquire('driver-profiles:nightly-full-sync')).toBe(false)
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT')
    expect(query.mock.calls[0][0]).toContain('INTERVAL')
    await first.release('driver-profiles:nightly-full-sync', { status: 'success' })
    expect(execute.mock.calls[0][0]).toContain('"errorMessage" = $2')
    expect(execute.mock.calls[0]).toContain('owner-a')
  })

  test('all six enabled parks run sequentially and one failure does not stop five', async () => {
    const shuffled = [...APPROVED_PARKS].reverse().map((park, index) => ({
      parkConnectionId: `pc-${index}`,
      apiConnectionId: `api-${index}`,
      parkId: `park-${index}`,
      parkCode: park.parkCode,
      parkName: park.parkName,
      externalParkId: park.externalParkId,
      enabled: true as const,
      clid: 'test-client',
      apiKey: 'test-key',
    }))
    const visited: string[] = []
    const result = await runProductionDriverProfileSync('scheduled', {
      lock: new InMemoryNightlySyncLock(),
      loadConnections: async () => shuffled,
      syncPark: async connection => {
        visited.push(connection.parkCode)
        if (connection.parkCode === 'YOKO_3') throw new Error('retry budget exhausted')
        return { profilesProcessed: 1, sourceRows: 1, dedupedRows: 1, inserts: 0, updates: 0, unchanged: 1, retries: 0, errors: 0 }
      },
    })
    expect(result.status).toBe('partial_failure')
    expect(visited).toEqual(shuffled.map(connection => connection.parkCode))
    expect(result.results.filter(park => park.status === 'success')).toHaveLength(5)
    expect(new Set(result.results.map(park => park.parkCode))).toEqual(new Set(APPROVED_PARKS.map(park => park.parkCode)))
  })

  test('canonical sync has no phone/name Contact linking or merge path', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/driver-profiles/production-sync.ts'), 'utf8')
    const manual = fs.readFileSync(path.join(process.cwd(), 'src/lib/yandexSync.ts'), 'utf8')
    expect(source).not.toContain('attachDriverProfilesToContactByPhone')
    expect(source).not.toContain('ContactService')
    expect(source).not.toContain('mergeContact')
    expect(manual).toContain("runProductionDriverProfileSync('manual')")
    expect(manual).not.toContain('syncActiveDrivers')
    expect(manual).not.toContain('syncArchivedDrivers')
  })
})
