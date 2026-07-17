import { opsLog } from '@/lib/opsLog'
import { prisma } from '@/lib/prisma'
import { retryDelayMs, sanitizeYandexProfile } from './park-inventory'
import {
  DatabaseNightlySyncLock,
  buildDriverProfileMutation,
  driverProfileParkRefreshLockKey,
} from './production-sync'
import { refreshContactMainDriver } from './multi-park'
import { getContactProfileRefreshDecision } from './refresh-policy'

const YANDEX_DRIVER_PROFILES_ENDPOINT = 'https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list'
const MAX_CARD_REFRESH_ATTEMPTS = 3
const NIGHTLY_LOCK_SERVICE = 'scheduler_lock:driver-profiles:nightly-full-sync'

type RefreshStatus = 'fresh' | 'refreshed' | 'backoff' | 'coalesced' | 'nightly_running' | 'failed'

export type ContactProfileParkRefreshResult = {
  parkCode: string
  parkName: string
  status: RefreshStatus
  retryAt: string | null
}

type RuntimeConnection = {
  id: string
  parkId: string
  apiConnectionId: string
  externalParkId: string
  lastSuccessfulSyncAt: Date | null
  lastFailedSyncAt: Date | null
  park: { parkCode: string; parkName: string }
  apiConnection: { clid: string; apiKey: string }
}

class RefreshFailure extends Error {
  constructor(
    readonly rawError: string,
    readonly retryAfterMs: number,
  ) {
    super(rawError)
  }
}

const inFlight = new Map<string, Promise<ContactProfileParkRefreshResult>>()

function resultFor(connection: RuntimeConnection, status: RefreshStatus, retryAt: Date | null = null): ContactProfileParkRefreshResult {
  return {
    parkCode: connection.park.parkCode,
    parkName: connection.park.parkName,
    status,
    retryAt: retryAt ? retryAt.toISOString() : null,
  }
}

async function isNightlyRunning(): Promise<boolean> {
  const row = await prisma.syncStatus.findUnique({
    where: { service: NIGHTLY_LOCK_SERVICE },
    select: { status: true },
  })
  return row?.status === 'running'
}

async function fetchProfiles(connection: RuntimeConnection, profileIds: string[]) {
  const body = {
    query: {
      park: { id: connection.externalParkId },
      driver_profile: { id: profileIds },
    },
    fields: {
      driver_profile: ['id', 'first_name', 'last_name', 'middle_name', 'phones', 'work_status', 'created_date', 'employment_type', 'driver_license'],
      current_status: ['status', 'status_updated_at'],
    },
    limit: Math.max(1, profileIds.length),
    offset: 0,
  }
  let retries = 0
  let rawError = 'Yandex request failed'
  let retryAfterMs = 0

  for (let attempt = 1; attempt <= MAX_CARD_REFRESH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(YANDEX_DRIVER_PROFILES_ENDPOINT, {
        method: 'POST',
        headers: {
          'X-Client-ID': connection.apiConnection.clid,
          'X-Api-Key': connection.apiConnection.apiKey,
          'X-Park-Id': connection.externalParkId,
          'Accept-Language': 'ru',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (response.ok) {
        const payload = await response.json() as { driver_profiles?: Record<string, unknown>[] }
        return { profiles: payload.driver_profiles || [], retries }
      }
      rawError = 'Yandex API ' + response.status + ': ' + (await response.text()).slice(0, 500)
      if (response.status !== 429) break
      retryAfterMs = retryDelayMs(attempt, response.headers.get('retry-after'))
      if (attempt === MAX_CARD_REFRESH_ATTEMPTS) break
      retries += 1
      await new Promise(resolve => setTimeout(resolve, retryAfterMs))
    } catch (error) {
      rawError = error instanceof Error ? error.message : String(error)
      if (attempt === MAX_CARD_REFRESH_ATTEMPTS) break
      retries += 1
      retryAfterMs = retryDelayMs(attempt, null)
      await new Promise(resolve => setTimeout(resolve, retryAfterMs))
    }
  }

  throw new RefreshFailure(rawError, retryAfterMs)
}

async function applyProfiles(input: {
  contactId: string
  connection: RuntimeConnection
  payloads: Record<string, unknown>[]
}) {
  const sourceProfiles = input.payloads
    .map(payload => sanitizeYandexProfile({
      externalParkId: input.connection.externalParkId,
      parkCode: input.connection.park.parkCode as never,
      parkName: input.connection.park.parkName,
      fetchedAt: new Date().toISOString(),
      payload,
    }))
    .filter((profile): profile is NonNullable<typeof profile> => Boolean(profile))

  if (sourceProfiles.length > 0) {
    const existingRows = await prisma.driver.findMany({
      where: {
        externalParkId: input.connection.externalParkId,
        externalDriverProfileId: { in: sourceProfiles.map(profile => profile.externalDriverProfileId) },
      },
    })
    const existingByExternalId = new Map(existingRows.map(row => [row.externalDriverProfileId, row]))
    for (const profile of sourceProfiles) {
      const mutation = buildDriverProfileMutation({
        profile,
        parkId: input.connection.parkId,
        sourceConnectionId: input.connection.apiConnectionId,
        existing: existingByExternalId.get(profile.externalDriverProfileId) as never,
      })
      if (!mutation.changed) continue
      await prisma.driver.upsert({
        where: mutation.where,
        update: mutation.update,
        create: mutation.create,
      })
    }
  }

  await prisma.parkConnection.update({
    where: { id: input.connection.id },
    data: { lastSuccessfulSyncAt: new Date(), lastErrorSummary: null },
  })
  await refreshContactMainDriver(input.contactId, 'card-open-refresh')
}

async function refreshOnePark(input: {
  contactId: string
  connection: RuntimeConnection
  profileIds: string[]
}): Promise<ContactProfileParkRefreshResult> {
  const decision = getContactProfileRefreshDecision({
    lastSuccessfulAt: input.connection.lastSuccessfulSyncAt,
    lastFailedAt: input.connection.lastFailedSyncAt,
  })
  if (decision.kind === 'fresh') return resultFor(input.connection, 'fresh')
  if (decision.kind === 'backoff') return resultFor(input.connection, 'backoff', decision.retryAt)
  if (await isNightlyRunning()) return resultFor(input.connection, 'nightly_running')

  const key = driverProfileParkRefreshLockKey(input.connection.externalParkId)
  const running = inFlight.get(key)
  if (running) {
    await running
    return resultFor(input.connection, 'coalesced')
  }

  const task = (async () => {
    const lock = new DatabaseNightlySyncLock()
    if (!await lock.acquire(key)) return resultFor(input.connection, 'coalesced')
    try {
      const latest = await prisma.parkConnection.findUnique({
        where: { id: input.connection.id },
        select: { lastSuccessfulSyncAt: true, lastFailedSyncAt: true },
      })
      const afterLock = getContactProfileRefreshDecision({
        lastSuccessfulAt: latest?.lastSuccessfulSyncAt || input.connection.lastSuccessfulSyncAt,
        lastFailedAt: latest?.lastFailedSyncAt || input.connection.lastFailedSyncAt,
      })
      if (afterLock.kind === 'fresh') {
        await lock.release(key, { status: 'success' })
        return resultFor(input.connection, 'fresh')
      }
      if (afterLock.kind === 'backoff') {
        await lock.release(key, { status: 'success' })
        return resultFor(input.connection, 'backoff', afterLock.retryAt)
      }
      if (await isNightlyRunning()) {
        await lock.release(key, { status: 'success' })
        return resultFor(input.connection, 'nightly_running')
      }

      const response = await fetchProfiles(input.connection, input.profileIds)
      await applyProfiles({ ...input, payloads: response.profiles })
      await lock.release(key, { status: 'success' })
      opsLog('info', 'contact_profile_refresh_result', {
        operation: 'contact-profile-refresh',
        contactId: input.contactId,
        parkCode: input.connection.park.parkCode,
        retries: response.retries,
      })
      return resultFor(input.connection, 'refreshed')
    } catch (error) {
      const failure = error instanceof RefreshFailure
        ? error
        : new RefreshFailure(error instanceof Error ? error.message : String(error), 0)
      const retryAt = new Date(Date.now() + Math.max(failure.retryAfterMs, 60_000))
      await prisma.parkConnection.update({
        where: { id: input.connection.id },
        data: { lastFailedSyncAt: new Date(), lastErrorSummary: failure.rawError.slice(0, 1000) },
      }).catch(() => undefined)
      await lock.release(key, { status: 'error', error: failure.rawError }).catch(() => undefined)
      opsLog('error', 'contact_profile_refresh_failed', {
        operation: 'contact-profile-refresh',
        contactId: input.contactId,
        parkCode: input.connection.park.parkCode,
        rawError: failure.rawError,
        retryAt: retryAt.toISOString(),
      })
      return resultFor(input.connection, 'failed', retryAt)
    }
  })()

  inFlight.set(key, task)
  try {
    return await task
  } finally {
    if (inFlight.get(key) === task) inFlight.delete(key)
  }
}

export async function refreshContactDriverProfiles(input: {
  contactId: string
  parkCode?: string
}): Promise<ContactProfileParkRefreshResult[]> {
  const attached = await prisma.driver.findMany({
    where: {
      contactId: input.contactId,
      externalParkId: { not: null },
      externalDriverProfileId: { not: null },
    },
    select: { externalParkId: true, externalDriverProfileId: true },
  })
  const idsByPark = new Map<string, Set<string>>()
  for (const profile of attached) {
    if (!profile.externalParkId || !profile.externalDriverProfileId) continue
    const ids = idsByPark.get(profile.externalParkId) || new Set<string>()
    ids.add(profile.externalDriverProfileId)
    idsByPark.set(profile.externalParkId, ids)
  }

  const connections = await prisma.parkConnection.findMany({
    where: { enabled: true, archivedAt: null },
    include: { park: true, apiConnection: true },
  }) as RuntimeConnection[]

  const results: ContactProfileParkRefreshResult[] = []
  for (const connection of connections) {
    if (input.parkCode && connection.park.parkCode !== input.parkCode) continue
    const ids = idsByPark.get(connection.externalParkId)
    if (!ids || ids.size === 0) continue
    results.push(await refreshOnePark({
      contactId: input.contactId,
      connection,
      profileIds: [...ids],
    }))
  }
  return results
}
