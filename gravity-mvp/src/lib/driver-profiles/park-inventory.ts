import { buildCompositeDriverProfileKey, dedupeSourceDriverProfiles, reconcileParkIdentity, resolveParkConnectionMappings, type ApiConnectionLike, type LegacyDriverProfile, type ParkCode, type SourceDriverProfile } from './park-identity'

export type InventoryPageCheckpoint = {
  parkCode: ParkCode
  requestedStatus: string
  offset: number
  total?: number
  completed: boolean
  rows: SourceDriverProfile[]
  retries: number
  rateLimitCount: number
  errors: string[]
}

export type InventoryConnectionReport = {
  apiConnectionId: string
  parkCode: ParkCode
  parkName: string
  externalParkId: string
  totalSourceRows: number
  dedupedRows: number
  duplicateRows: number
  retries: number
  rateLimitCount: number
  status: 'COMPLETE' | 'INCOMPLETE'
  errors: string[]
}

export type InventorySnapshot = {
  generatedAt: string
  writes: false
  connections: InventoryConnectionReport[]
  sourceProfiles: SourceDriverProfile[]
  sourceProfileKeys: string[]
  reconciliation?: ReturnType<typeof reconcileParkIdentity>
}

export function retryDelayMs(attempt: number, retryAfterHeader: string | null, random = Math.random): number {
  if (retryAfterHeader) {
    const seconds = Number.parseInt(retryAfterHeader, 10)
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 120_000)
  }
  const base = Math.min(120_000, 1000 * 2 ** Math.max(0, attempt - 1))
  const jitter = Math.floor(random() * Math.min(1000, base))
  return base + jitter
}

export function sanitizeYandexProfile(input: {
  externalParkId: string
  parkCode: ParkCode
  parkName: string
  fetchedAt: string
  payload: Record<string, unknown>
}): SourceDriverProfile | null {
  const driverProfile = (input.payload.driver_profile || {}) as Record<string, unknown>
  const currentStatus = (input.payload.current_status || {}) as Record<string, unknown>
  const id = typeof driverProfile.id === 'string' ? driverProfile.id : null
  if (!id) return null
  const phones = Array.isArray(driverProfile.phones) ? driverProfile.phones : []
  const firstName = typeof driverProfile.first_name === 'string' ? driverProfile.first_name : ''
  const lastName = typeof driverProfile.last_name === 'string' ? driverProfile.last_name : ''
  const middleName = typeof driverProfile.middle_name === 'string' ? driverProfile.middle_name : ''
  const fullName = [lastName, firstName, middleName].filter(Boolean).join(' ').trim() || null
  return {
    externalParkId: input.externalParkId,
    externalDriverProfileId: id,
    parkCode: input.parkCode,
    parkName: input.parkName,
    phone: typeof phones[0] === 'string' ? phones[0] : null,
    fullName,
    employmentType: typeof driverProfile.employment_type === 'string' ? driverProfile.employment_type : null,
    sourceWorkStatus: typeof driverProfile.work_status === 'string' ? driverProfile.work_status : null,
    sourceCurrentStatus: typeof currentStatus.status === 'string' ? currentStatus.status : null,
    sourceUpdatedAt: typeof currentStatus.status_updated_at === 'string' ? currentStatus.status_updated_at : null,
    fetchedAt: input.fetchedAt,
  }
}

export function buildInventorySnapshot(input: {
  connections: ApiConnectionLike[]
  pages: InventoryPageCheckpoint[]
  legacyDrivers?: LegacyDriverProfile[]
  generatedAt?: string
}): InventorySnapshot {
  const mapping = resolveParkConnectionMappings(input.connections)
  const rows = input.pages.flatMap(page => page.rows)
  const deduped = dedupeSourceDriverProfiles(rows)
  const incompleteParkCodes = input.pages.filter(page => !page.completed).map(page => page.parkCode)
  const reports = mapping.mappings.map(park => {
    const pages = input.pages.filter(page => page.parkCode === park.parkCode)
    const totalSourceRows = pages.reduce((sum, page) => sum + page.rows.length, 0)
    const dedupedRows = dedupeSourceDriverProfiles(pages.flatMap(page => page.rows)).profiles.length
    const errors = [...mapping.errors, ...pages.flatMap(page => page.errors)]
    return {
      apiConnectionId: park.apiConnectionId,
      parkCode: park.parkCode,
      parkName: park.parkName,
      externalParkId: park.externalParkId,
      totalSourceRows,
      dedupedRows,
      duplicateRows: totalSourceRows - dedupedRows,
      retries: pages.reduce((sum, page) => sum + page.retries, 0),
      rateLimitCount: pages.reduce((sum, page) => sum + page.rateLimitCount, 0),
      status: pages.length > 0 && pages.every(page => page.completed) ? 'COMPLETE' as const : 'INCOMPLETE' as const,
      errors,
    }
  })

  return {
    generatedAt: input.generatedAt || new Date().toISOString(),
    writes: false,
    connections: reports,
    sourceProfiles: deduped.profiles,
    sourceProfileKeys: deduped.profiles.map(profile => buildCompositeDriverProfileKey(profile.externalParkId, profile.externalDriverProfileId)).sort(),
    reconciliation: input.legacyDrivers ? reconcileParkIdentity(input.legacyDrivers, deduped.profiles, Array.from(new Set(incompleteParkCodes))) : undefined,
  }
}
