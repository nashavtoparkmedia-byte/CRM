import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { opsLog } from '@/lib/opsLog'
import { prisma } from '@/lib/prisma'
import { refreshContactMainDriver } from './multi-park'
import { APPROVED_PARKS, dedupeSourceDriverProfiles, type SourceDriverProfile } from './park-identity'
import { retryDelayMs, sanitizeYandexProfile } from './park-inventory'
import { normalizePhoneE164 } from '@/lib/phoneUtils'
import {
  NIGHTLY_DRIVER_PROFILE_SYNC_LOCK_KEY,
  runNightlyDriverProfileSync,
  type NightlyParkConnection,
  type NightlySyncLock,
  type NightlySyncRunResult,
} from './nightly-sync'

const YANDEX_DRIVER_PROFILES_ENDPOINT = 'https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list'
const PROFILE_PAGE_LIMIT = 1000
const PROFILE_STATUSES = ['working', 'dismissed'] as const
const LOCK_STALE_MS = 4 * 60 * 60 * 1000
const LOCK_SERVICE_PREFIX = 'scheduler_lock:'

export function driverProfileParkRefreshLockKey(externalParkId: string): string {
  return 'driver-profiles:park-refresh:' + externalParkId
}

type RuntimeParkConnection = NightlyParkConnection & {
  parkConnectionId: string
  parkId: string
  clid: string
  apiKey: string
}

type ExistingDriverProfile = {
  id: string
  yandexDriverId: string
  externalParkId: string | null
  externalDriverProfileId: string | null
  parkId: string | null
  sourceConnectionId: string | null
  fullName: string
  phone: string | null
  lastExternalPark: string | null
  statusOverride: string | null
  lastFleetCheckStatus: string | null
  lastFleetCheckAt: Date | null
  dismissedAt: Date | null
  customFields: Prisma.JsonValue | null
  contactId: string | null
}

type DriverProfileMutation = {
  where: Prisma.DriverWhereUniqueInput
  update: Prisma.DriverUncheckedUpdateInput
  create: Prisma.DriverUncheckedCreateInput
  changed: boolean
  statusChanged: boolean
}

type FailureStats = {
  profilesProcessed: number
  sourceRows: number
  dedupedRows: number
  inserts: number
  updates: number
  unchanged: number
  retries: number
  errors: number
}

class ParkSyncFailure extends Error {
  constructor(message: string, readonly nightlyStats: Partial<FailureStats>) {
    super(message)
    this.name = 'ParkSyncFailure'
  }
}

type ProductionSyncDependencies = {
  db?: typeof prisma
  fetchFn?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  lock?: NightlySyncLock
  loadConnections?: () => Promise<RuntimeParkConnection[]>
  syncPark?: (connection: RuntimeParkConnection) => ReturnType<typeof syncDriverProfilesForPark>
}

function asJsonObject(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Prisma.JsonObject).filter((entry): entry is [string, Prisma.JsonValue] => entry[1] !== undefined),
  )
}

function dateOrNull(value?: string | null): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function comparable(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return JSON.stringify(value) ?? String(value)
}

export function normalizeDriverProfileStatus(profile: SourceDriverProfile): 'working' | 'dismissed' | 'unknown' {
  const work = profile.sourceWorkStatus?.trim().toLowerCase() || ''
  const current = profile.sourceCurrentStatus?.trim().toLowerCase() || ''
  if (['dismissed', 'fired', 'terminated'].includes(work) || ['dismissed', 'fired', 'terminated'].includes(current)) return 'dismissed'
  if (work === 'working') return 'working'
  return 'unknown'
}

export function sourceOnlyYandexDriverId(profile: Pick<SourceDriverProfile, 'externalParkId' | 'externalDriverProfileId'>): string {
  return `park:${profile.externalParkId.trim()}:${profile.externalDriverProfileId.trim()}`
}

export function buildDriverProfileMutation(input: {
  profile: SourceDriverProfile
  parkId: string
  sourceConnectionId: string
  existing?: ExistingDriverProfile | null
}): DriverProfileMutation {
  const { profile, existing } = input
  const externalParkId = profile.externalParkId.trim()
  const externalDriverProfileId = profile.externalDriverProfileId.trim()
  const normalizedStatus = normalizeDriverProfileStatus(profile)
  const sourceUpdatedAt = dateOrNull(profile.sourceUpdatedAt)
  const statusChanged = Boolean(existing && normalizedStatus !== 'unknown' && existing.statusOverride !== normalizedStatus)
  const previousCustomFields = asJsonObject(existing?.customFields || null)
  const previousYandex = asJsonObject((previousCustomFields.yandexProfile as Prisma.JsonValue | undefined) || null)
  const yandexProfile: Prisma.JsonObject = {
    ...previousYandex,
    employmentType: profile.employmentType ?? null,
    sourceUpdatedAt: profile.sourceUpdatedAt ?? null,
    sourceWorkStatus: profile.sourceWorkStatus ?? null,
    sourceCurrentStatus: profile.sourceCurrentStatus ?? null,
  }
  const customFields: Prisma.InputJsonObject = { ...previousCustomFields, yandexProfile }
  const dismissedAt = normalizedStatus === 'dismissed'
    ? sourceUpdatedAt || existing?.dismissedAt || dateOrNull(profile.fetchedAt)
    : normalizedStatus === 'working' ? null : existing?.dismissedAt || null
  const statusOverride = normalizedStatus === 'unknown'
    ? existing?.statusOverride || 'unknown'
    : normalizedStatus
  const currentStatus = profile.sourceCurrentStatus || profile.sourceWorkStatus || statusOverride
  const update: Prisma.DriverUncheckedUpdateInput = {
    externalParkId,
    externalDriverProfileId,
    parkId: input.parkId,
    sourceConnectionId: input.sourceConnectionId,
    fullName: profile.fullName || existing?.fullName || 'Без имени',
    phone: normalizePhoneE164(profile.phone),
    lastExternalPark: profile.parkName,
    statusOverride,
    lastFleetCheckStatus: currentStatus,
    lastFleetCheckAt: sourceUpdatedAt || existing?.lastFleetCheckAt || null,
    dismissedAt,
    customFields,
  }
  const create: Prisma.DriverUncheckedCreateInput = {
    ...update,
    yandexDriverId: sourceOnlyYandexDriverId(profile),
    segment: 'unknown',
    personResolutionStatus: 'unlinked',
    personResolutionBasis: 'source_only_scheduler',
  } as Prisma.DriverUncheckedCreateInput
  const changed = !existing || Object.entries(update).some(([key, value]) => {
    const previous = existing[key as keyof ExistingDriverProfile]
    return comparable(previous) !== comparable(value)
  })

  return {
    where: {
      externalParkId_externalDriverProfileId: {
        externalParkId,
        externalDriverProfileId,
      },
    },
    update,
    create,
    changed,
    statusChanged,
  }
}

export class DatabaseNightlySyncLock implements NightlySyncLock {
  private readonly owners = new Map<string, string>()

  constructor(
    private readonly db: typeof prisma = prisma,
    private readonly tokenFactory: () => string = randomUUID,
    private readonly staleMs: number = LOCK_STALE_MS,
  ) {}

  async acquire(key: string): Promise<boolean> {
    const owner = this.tokenFactory()
    const service = `${LOCK_SERVICE_PREFIX}${key}`
    const rows = await this.db.$queryRawUnsafe<Array<{ locked: boolean }>>(
      `INSERT INTO "SyncStatus" ("service", "lastRunAt", "status", "errorMessage", "updatedAt")
       VALUES ($1, NOW(), 'running', $2, NOW())
       ON CONFLICT ("service") DO UPDATE
       SET "lastRunAt" = NOW(), "status" = 'running', "errorMessage" = EXCLUDED."errorMessage", "updatedAt" = NOW()
       WHERE "SyncStatus"."status" <> 'running'
          OR "SyncStatus"."lastRunAt" < NOW() - ($3 * INTERVAL '1 millisecond')
       RETURNING TRUE AS locked`,
      service,
      owner,
      this.staleMs,
    )
    if (rows.length === 0 || !rows[0].locked) return false
    this.owners.set(key, owner)
    return true
  }

  async release(key: string, outcome: { status: 'success' | 'error'; error?: string } = { status: 'success' }): Promise<void> {
    const owner = this.owners.get(key)
    if (!owner) return
    await this.db.$executeRawUnsafe(
      `UPDATE "SyncStatus"
       SET "lastRunAt" = NOW(), "status" = $3, "errorMessage" = $4, "updatedAt" = NOW()
       WHERE "service" = $1 AND "status" = 'running' AND "errorMessage" = $2`,
      `${LOCK_SERVICE_PREFIX}${key}`,
      owner,
      outcome.status,
      outcome.error?.slice(0, 1000) || null,
    )
    this.owners.delete(key)
  }
}

async function fetchProfilePage(input: {
  connection: RuntimeParkConnection
  requestedStatus: typeof PROFILE_STATUSES[number]
  offset: number
  fetchFn: typeof fetch
  sleep: (ms: number) => Promise<void>
  random: () => number
}): Promise<{ rows: Record<string, unknown>[]; total: number; retries: number }> {
  const payload = {
    query: { park: { id: input.connection.externalParkId }, driver: { status: [input.requestedStatus] } },
    fields: {
      driver_profile: ['id', 'first_name', 'last_name', 'middle_name', 'phones', 'work_status', 'created_date', 'employment_type', 'driver_license'],
      current_status: ['status', 'status_updated_at'],
    },
    limit: PROFILE_PAGE_LIMIT,
    offset: input.offset,
  }
  let retries = 0
  let lastError = 'Yandex request failed'
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await input.fetchFn(YANDEX_DRIVER_PROFILES_ENDPOINT, {
        method: 'POST',
        headers: {
          'X-Client-ID': input.connection.clid,
          'X-Api-Key': input.connection.apiKey,
          'X-Park-Id': input.connection.externalParkId,
          'Accept-Language': 'ru',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      if (response.ok) {
        const body = await response.json() as { driver_profiles?: Record<string, unknown>[]; total?: number }
        return { rows: body.driver_profiles || [], total: body.total || 0, retries }
      }
      const body = (await response.text()).slice(0, 500)
      lastError = `Yandex API ${response.status}: ${body}`
      if (response.status !== 429 && response.status < 500) throw new Error(lastError)
      if (attempt === 5) break
      retries += 1
      await input.sleep(retryDelayMs(attempt, response.headers.get('retry-after'), input.random))
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt === 5 || /^Yandex API 4(?!29)/.test(lastError)) break
      retries += 1
      await input.sleep(retryDelayMs(attempt, null, input.random))
    }
  }
  throw new ParkSyncFailure(`${input.connection.parkCode} ${input.requestedStatus}: ${lastError}`, { retries, errors: 1 })
}

async function fetchDriverProfilesForPark(input: {
  connection: RuntimeParkConnection
  fetchFn: typeof fetch
  sleep: (ms: number) => Promise<void>
  random: () => number
}): Promise<{ profiles: SourceDriverProfile[]; sourceRows: number; retries: number }> {
  const fetchedAt = new Date().toISOString()
  const sourceProfiles: SourceDriverProfile[] = []
  let sourceRows = 0
  let retries = 0
  for (const requestedStatus of PROFILE_STATUSES) {
    let offset = 0
    for (let page = 0; page < 100; page += 1) {
      let result: Awaited<ReturnType<typeof fetchProfilePage>>
      try {
        result = await fetchProfilePage({ ...input, requestedStatus, offset })
      } catch (error) {
        if (error instanceof ParkSyncFailure) {
          throw new ParkSyncFailure(error.message, {
            sourceRows,
            profilesProcessed: sourceProfiles.length,
            retries: retries + (error.nightlyStats.retries || 0),
            errors: 1,
          })
        }
        throw error
      }
      retries += result.retries
      sourceRows += result.rows.length
      for (const payload of result.rows) {
        const profile = sanitizeYandexProfile({
          externalParkId: input.connection.externalParkId,
          parkCode: input.connection.parkCode,
          parkName: input.connection.parkName,
          fetchedAt,
          payload,
        })
        if (profile) sourceProfiles.push(profile)
      }
      offset += PROFILE_PAGE_LIMIT
      if (result.rows.length === 0 || offset >= result.total) break
      await input.sleep(400)
      if (page === 99) throw new Error(`${input.connection.parkCode} exceeded the 100-page safety limit`)
    }
  }
  return { profiles: sourceProfiles, sourceRows, retries }
}

async function loadRuntimeConnections(db: typeof prisma): Promise<RuntimeParkConnection[]> {
  const rows = await db.parkConnection.findMany({
    where: { enabled: true, archivedAt: null },
    include: { park: true, apiConnection: true },
  })
  const byExternalParkId = new Map<string, typeof rows>()
  for (const row of rows) {
    byExternalParkId.set(row.externalParkId, [...(byExternalParkId.get(row.externalParkId) || []), row])
  }
  const errors: string[] = []
  const connections: RuntimeParkConnection[] = []
  for (const approved of APPROVED_PARKS) {
    const matches = byExternalParkId.get(approved.externalParkId) || []
    if (matches.length !== 1) {
      errors.push(`${approved.parkCode} has ${matches.length} enabled ParkConnection rows`)
      continue
    }
    const row = matches[0]
    if (row.park.externalParkId !== approved.externalParkId || row.apiConnection.parkId !== approved.externalParkId) {
      errors.push(`${approved.parkCode} ParkConnection identity mismatch`)
      continue
    }
    connections.push({
      parkConnectionId: row.id,
      apiConnectionId: row.apiConnectionId,
      parkId: row.parkId,
      parkCode: approved.parkCode,
      parkName: approved.parkName,
      externalParkId: approved.externalParkId,
      enabled: true,
      clid: row.apiConnection.clid,
      apiKey: row.apiConnection.apiKey,
    })
  }
  const unexpected = rows.filter(row => !APPROVED_PARKS.some(park => park.externalParkId === row.externalParkId))
  if (unexpected.length > 0) errors.push(`${unexpected.length} enabled ParkConnection rows have unknown park identity`)
  if (errors.length > 0 || connections.length !== APPROVED_PARKS.length) {
    throw new Error(`multi-park scheduler mapping invalid: ${errors.join('; ')}`)
  }
  return connections
}

async function syncDriverProfilesForPark(
  connection: RuntimeParkConnection,
  dependencies: Pick<ProductionSyncDependencies, 'db' | 'fetchFn' | 'sleep' | 'random'> = {},
) {
  const db = dependencies.db || prisma
  const fetchFn = dependencies.fetchFn || fetch
  const sleep = dependencies.sleep || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  const random = dependencies.random || Math.random
  const parkRefreshLock = new DatabaseNightlySyncLock(db)
  const parkLockKey = driverProfileParkRefreshLockKey(connection.externalParkId)
  if (!await parkRefreshLock.acquire(parkLockKey)) {
    opsLog('info', 'multi_park_sync_park_skipped_busy', {
      operation: NIGHTLY_DRIVER_PROFILE_SYNC_LOCK_KEY,
      parkCode: connection.parkCode,
    })
    return {
      profilesProcessed: 0,
      sourceRows: 0,
      dedupedRows: 0,
      inserts: 0,
      updates: 0,
      unchanged: 0,
      retries: 0,
      errors: 0,
    }
  }
  let failureStats: Partial<FailureStats> = { errors: 1 }
  try {
    const source = await fetchDriverProfilesForPark({ connection, fetchFn, sleep, random })
    const deduped = dedupeSourceDriverProfiles(source.profiles)
    failureStats = {
      profilesProcessed: deduped.profiles.length,
      sourceRows: source.sourceRows,
      dedupedRows: deduped.profiles.length,
      retries: source.retries,
      errors: 1,
    }
    const existingRows = await db.driver.findMany({
      where: { externalParkId: connection.externalParkId },
      select: {
        id: true,
        yandexDriverId: true,
        externalParkId: true,
        externalDriverProfileId: true,
        parkId: true,
        sourceConnectionId: true,
        fullName: true,
        phone: true,
        lastExternalPark: true,
        statusOverride: true,
        lastFleetCheckStatus: true,
        lastFleetCheckAt: true,
        dismissedAt: true,
        customFields: true,
        contactId: true,
      },
    })
    const existingByExternalId = new Map(existingRows.map(row => [row.externalDriverProfileId, row as ExistingDriverProfile]))
    const linkedContacts = new Set<string>()
    let inserts = 0
    let updates = 0
    let unchanged = 0
    for (const profile of deduped.profiles) {
      const existing = existingByExternalId.get(profile.externalDriverProfileId) || null
      const mutation = buildDriverProfileMutation({ profile, parkId: connection.parkId, sourceConnectionId: connection.apiConnectionId, existing })
      if (existing?.contactId) linkedContacts.add(existing.contactId)
      if (!mutation.changed) {
        unchanged += 1
        continue
      }
      await db.driver.upsert({ where: mutation.where, update: mutation.update, create: mutation.create })
      if (existing) updates += 1
      else inserts += 1
    }
    for (const contactId of linkedContacts) {
      await refreshContactMainDriver(contactId, 'multi-park-nightly-sync')
    }
    await db.parkConnection.update({
      where: { id: connection.parkConnectionId },
      data: { lastSuccessfulSyncAt: new Date(), lastErrorSummary: null },
    })
    const result = {
      profilesProcessed: deduped.profiles.length,
      sourceRows: source.sourceRows,
      dedupedRows: deduped.profiles.length,
      inserts,
      updates,
      unchanged,
      retries: source.retries,
      errors: 0,
    }
    await parkRefreshLock.release(parkLockKey, { status: 'success' })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await parkRefreshLock.release(parkLockKey, { status: 'error', error: message }).catch(() => undefined)
    await db.parkConnection.updateMany({
      where: { apiConnectionId: connection.apiConnectionId, externalParkId: connection.externalParkId, archivedAt: null },
      data: { lastFailedSyncAt: new Date(), lastErrorSummary: message.slice(0, 1000) },
    }).catch(() => undefined)
    if (error instanceof ParkSyncFailure) throw error
    throw new ParkSyncFailure(message, failureStats)
  }
}

export async function runProductionDriverProfileSync(
  trigger: 'scheduled' | 'manual',
  dependencies: ProductionSyncDependencies = {},
): Promise<NightlySyncRunResult> {
  const db = dependencies.db || prisma
  const runtimeConnections = await (dependencies.loadConnections || (() => loadRuntimeConnections(db)))()
  const byConnectionId = new Map(runtimeConnections.map(connection => [connection.apiConnectionId, connection]))
  const result = await runNightlyDriverProfileSync({
    connections: runtimeConnections,
    lock: dependencies.lock || new DatabaseNightlySyncLock(db),
    maxAttempts: 1,
    syncPark: async connection => {
      const runtime = byConnectionId.get(connection.apiConnectionId)
      if (!runtime) throw new Error(`runtime ParkConnection missing: ${connection.apiConnectionId}`)
      return dependencies.syncPark
        ? dependencies.syncPark(runtime)
        : syncDriverProfilesForPark(runtime, dependencies)
    },
  })
  if (result.status === 'skipped_locked') {
    opsLog('info', 'multi_park_sync_skipped_lock_held', { operation: NIGHTLY_DRIVER_PROFILE_SYNC_LOCK_KEY, trigger })
  } else {
    for (const park of result.results) {
      opsLog(park.status === 'success' ? 'info' : 'error', 'multi_park_sync_park_result', {
        operation: NIGHTLY_DRIVER_PROFILE_SYNC_LOCK_KEY,
        trigger,
        ...park,
      })
    }
    opsLog(result.status === 'success' ? 'info' : 'error', 'multi_park_sync_completed', {
      operation: NIGHTLY_DRIVER_PROFILE_SYNC_LOCK_KEY,
      trigger,
      status: result.status,
      parks: result.results.length,
    })
  }
  return result
}
