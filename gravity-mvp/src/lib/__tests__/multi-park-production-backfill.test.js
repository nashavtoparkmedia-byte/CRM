import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const backfill = require('../../../scripts/multi-park-final-backfill.js')

const parks = backfill.APPROVED_PARKS
const apiConnections = parks.map((park) => ({ id: `conn-${park.parkCode}`, parkId: park.externalParkId, name: park.parkName }))
const source = (park, externalDriverProfileId, extra = {}) => ({
  externalParkId: park.externalParkId,
  externalDriverProfileId,
  parkCode: park.parkCode,
  parkName: park.parkName,
  phone: '+7 922 215-57-50',
  fullName: 'Driver One',
  sourceWorkStatus: 'working',
  sourceCurrentStatus: 'online',
  fetchedAt: '2026-07-13T00:00:00.000Z',
  ...extra,
})
const sixParkSnapshot = (extra = []) => parks.map((park, index) => source(park, `profile-${index}`)).concat(extra)

describe('multi-park production backfill safety', () => {
  it('defaults to dry-run and requires bounded batch size', () => {
    expect(backfill.parseArgs(['node', 'script'])).toMatchObject({ dryRun: true, write: false })
    expect(() => backfill.parseArgs(['node', 'script', '--batch-size', '0'])).toThrow(/batch-size/)
  })

  it('blocks write without a backup marker and derived confirmation token', () => {
    const args = backfill.parseArgs(['node', 'script', '--write', '--release-id', 'rel-1'])
    expect(() => backfill.assertWriteSafety(args, { commit: 'abc', snapshotSha256: 'snap' })).toThrow(/backup-marker/)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-backfill-'))
    const marker = path.join(dir, 'backup-marker.json')
    fs.writeFileSync(marker, JSON.stringify({ timestamp: '2026-07-13T00:00:00Z', dbIdentity: 'db:5432/crm', dumpPath: '/tmp/dump.sql', sha256: 'dump-sha' }))
    const bad = backfill.parseArgs(['node', 'script', '--write', '--release-id', 'rel-1', '--backup-marker', marker, '--confirmation-token', 'yes'])
    expect(() => backfill.assertWriteSafety(bad, { commit: 'abc', snapshotSha256: 'snap' })).toThrow(/confirmation token/)
    const token = backfill.generateConfirmationToken({ releaseId: 'rel-1', dbIdentity: 'db:5432/crm', expectedCommit: 'abc', snapshotSha256: 'snap' })
    const good = backfill.parseArgs(['node', 'script', '--write', '--release-id', 'rel-1', '--backup-marker', marker, '--confirmation-token', token, '--expected-commit', 'abc'])
    expect(backfill.assertWriteSafety(good, { commit: 'abc', snapshotSha256: 'snap' })).toMatchObject({ dbIdentity: 'db:5432/crm' })
  })
})

describe('multi-park production backfill planning', () => {
  it('validates six parks and dedupes source rows by composite identity', () => {
    const park = parks[0]
    const validation = backfill.validateSourceSnapshot({ profiles: [source(park, 'same'), source(park, 'same', { sourceUpdatedAt: '2026-07-13T01:00:00.000Z' }), ...parks.slice(1).map((p, i) => source(p, `p-${i}`))] })
    expect(validation.errors).toEqual([])
    expect(validation.profiles).toHaveLength(6)
    expect(validation.duplicateKeys).toHaveLength(1)
  })

  it('plans exact legacy update without changing contactId or linking by phone/name', () => {
    const p = parks[0]
    const plan = backfill.planBackfill({
      apiConnections,
      sourceProfiles: sixParkSnapshot(),
      existingParks: parks.map((park) => ({ id: `park-${park.parkCode}`, ...park, active: true })),
      existingParkConnections: apiConnections.map((conn, index) => ({ id: `pc-${index}`, apiConnectionId: conn.id, parkId: `park-${parks[index].parkCode}`, externalParkId: parks[index].externalParkId, enabled: true, archivedAt: null })),
      legacyDrivers: [{ id: 'driver-1', yandexDriverId: 'profile-0', fullName: 'Old Name', phone: '+70000000000', contactId: 'contact-1' }],
    })
    expect(plan.errors).toEqual([])
    expect(plan.summary.exactLegacyMatches).toBe(1)
    expect(plan.operations.legacyUpdates[0].update).toMatchObject({ externalParkId: p.externalParkId, externalDriverProfileId: 'profile-0' })
    expect(plan.operations.legacyUpdates[0].update).not.toHaveProperty('contactId')
    expect(plan.summary.contactAutoLinks).toBe(0)
    expect(plan.summary.contactMerges).toBe(0)
  })

  it('creates source-only profile with composite-safe yandexDriverId and no contact link', () => {
    const plan = backfill.planBackfill({ apiConnections, sourceProfiles: sixParkSnapshot(), existingParks: [], existingParkConnections: [], legacyDrivers: [] })
    expect(plan.summary.sourceOnlyProfiles).toBe(6)
    expect(plan.operations.sourceOnlyInserts[0].data.yandexDriverId).toMatch(/^park:/)
    expect(plan.operations.sourceOnlyInserts[0].data).not.toHaveProperty('contactId')
    expect(plan.operations.sourceOnlyInserts[0].data.personResolutionStatus).toBe('unlinked')
  })

  it('blocks collision when one legacy id maps to multiple parks', () => {
    const rows = sixParkSnapshot([source(parks[1], 'profile-0')])
    const plan = backfill.planBackfill({ apiConnections, sourceProfiles: rows, legacyDrivers: [{ id: 'driver-1', yandexDriverId: 'profile-0' }] })
    expect(plan.summary.collisions).toBe(1)
    expect(plan.errors.join('\n')).toMatch(/collisions detected/)
  })

  it('blocks incomplete source snapshot before write', () => {
    const plan = backfill.planBackfill({ apiConnections, sourceProfiles: [source(parks[0], 'only-one')], legacyDrivers: [] })
    expect(plan.summary.unresolved).toBeGreaterThan(0)
    expect(plan.errors.join('\n')).toMatch(/incomplete source snapshot/)
  })

  it('uses existing composite profile on rerun instead of inserting duplicate', () => {
    const p = parks[0]
    const existingKey = backfill.compositeKey(p.externalParkId, 'profile-0')
    const plan = backfill.planBackfill({
      apiConnections,
      sourceProfiles: sixParkSnapshot(),
      legacyDrivers: [],
      existingDriversByComposite: new Map([[existingKey, { id: 'existing', externalParkId: p.externalParkId, externalDriverProfileId: 'profile-0', parkId: `park-${p.parkCode}`, sourceConnectionId: `conn-${p.parkCode}`, lastExternalPark: p.parkName, statusOverride: 'working', lastFleetCheckStatus: 'online', lastFleetCheckAt: new Date('2026-07-13T00:00:00.000Z'), contactId: 'contact-kept' }]]),
    })
    expect(plan.operations.sourceOnlyInserts.some((op) => op.key === existingKey)).toBe(false)
    expect(plan.operations.sourceOnlyUpdates.find((op) => op.key === existingKey)?.update).not.toHaveProperty('contactId')
  })
})
