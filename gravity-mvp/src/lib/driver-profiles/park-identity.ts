export const PARK_CODES = [
  'NASH_AVTOPARK',
  'YOKO',
  'YOKO_2',
  'YOKO_3',
  'YOKO_4',
  'YOKO_DELIVERY',
] as const

export type ParkCode = typeof PARK_CODES[number]

export type ApprovedPark = {
  parkCode: ParkCode
  parkName: string
  externalParkId: string
  priority: number
}

export const APPROVED_PARKS: readonly ApprovedPark[] = [
  { parkCode: 'NASH_AVTOPARK', parkName: '\u041d\u0430\u0448 \u0410\u0432\u0442\u043e\u043f\u0430\u0440\u043a', externalParkId: '45e30e9d6b824c608e5d28719cb19a6e', priority: 1 },
  { parkCode: 'YOKO', parkName: 'YOKO', externalParkId: '3a23295d8d714c03b61a17a6fc86601b', priority: 2 },
  { parkCode: 'YOKO_2', parkName: 'YOKO-2', externalParkId: 'a0e45c39ffc64ecdaec96fe02cb221d9', priority: 3 },
  { parkCode: 'YOKO_3', parkName: 'YOKO-3', externalParkId: '9acdd6782806467ab284ac269a719324', priority: 4 },
  { parkCode: 'YOKO_4', parkName: 'YOKO-4', externalParkId: '02a96db4914c4a59adf874a1f07d97b7', priority: 5 },
  { parkCode: 'YOKO_DELIVERY', parkName: 'YOKO.\u0414\u043e\u0441\u0442\u0430\u0432\u043a\u0430', externalParkId: 'b3d310d51da54b15a9306420c820469e', priority: 6 },
]

export type ApiConnectionLike = {
  id: string
  parkId: string
  name?: string | null
  createdAt?: Date | string
}

export type ParkConnectionMapping = ApprovedPark & {
  apiConnectionId: string
  enabled: true
}

export type ParkMappingResult = {
  mappings: ParkConnectionMapping[]
  errors: string[]
}

export function buildCompositeDriverProfileKey(externalParkId: string, externalDriverProfileId: string): string {
  const park = externalParkId.trim()
  const profile = externalDriverProfileId.trim()
  if (!park || !profile) throw new Error('externalParkId and externalDriverProfileId are required')
  return `${park}:${profile}`
}

export function resolveParkConnectionMappings(connections: ApiConnectionLike[]): ParkMappingResult {
  const byExternalParkId = new Map(APPROVED_PARKS.map(park => [park.externalParkId, park]))
  const seenConnectionIds = new Set<string>()
  const seenParkCodes = new Set<ParkCode>()
  const seenExternalParkIds = new Set<string>()
  const mappings: ParkConnectionMapping[] = []
  const errors: string[] = []

  for (const connection of connections) {
    if (seenConnectionIds.has(connection.id)) {
      errors.push(`duplicate ApiConnection id ${connection.id}`)
      continue
    }
    seenConnectionIds.add(connection.id)

    const park = byExternalParkId.get(connection.parkId)
    if (!park) {
      errors.push(`unknown Yandex ApiConnection parkId ${connection.parkId} (${connection.id})`)
      continue
    }
    if (seenParkCodes.has(park.parkCode)) errors.push(`parkCode ${park.parkCode} is mapped more than once`)
    if (seenExternalParkIds.has(park.externalParkId)) errors.push(`externalParkId ${park.externalParkId} is mapped more than once`)
    seenParkCodes.add(park.parkCode)
    seenExternalParkIds.add(park.externalParkId)
    mappings.push({ ...park, apiConnectionId: connection.id, enabled: true })
  }

  for (const park of APPROVED_PARKS) {
    if (!seenParkCodes.has(park.parkCode)) errors.push(`missing ApiConnection mapping for ${park.parkCode}`)
  }

  return { mappings: mappings.sort((a, b) => a.priority - b.priority), errors }
}

export type SourceDriverProfile = {
  externalParkId: string
  externalDriverProfileId: string
  parkCode: ParkCode
  parkName: string
  phone: string | null
  fullName: string | null
  employmentType?: string | null
  sourceWorkStatus?: string | null
  sourceCurrentStatus?: string | null
  sourceUpdatedAt?: string | null
  fetchedAt?: string
}

export type DedupeResult = {
  profiles: SourceDriverProfile[]
  duplicates: Array<{ key: string; count: number }>
}

export function dedupeSourceDriverProfiles(rows: SourceDriverProfile[]): DedupeResult {
  const byKey = new Map<string, { first: SourceDriverProfile; count: number }>()
  for (const row of rows) {
    const key = buildCompositeDriverProfileKey(row.externalParkId, row.externalDriverProfileId)
    const existing = byKey.get(key)
    if (existing) {
      existing.count += 1
      if (!existing.first.sourceUpdatedAt && row.sourceUpdatedAt) existing.first = row
      continue
    }
    byKey.set(key, { first: row, count: 1 })
  }
  return {
    profiles: Array.from(byKey.values()).map(item => item.first),
    duplicates: Array.from(byKey.entries())
      .filter(([, item]) => item.count > 1)
      .map(([key, item]) => ({ key, count: item.count })),
  }
}

export type LegacyDriverProfile = {
  id: string
  yandexDriverId: string
  externalParkId?: string | null
  externalDriverProfileId?: string | null
  phone?: string | null
  fullName?: string | null
  contactId?: string | null
  dismissedAt?: Date | string | null
}

export type ReconciliationResult = {
  exactMatches: Array<{ legacyDriverId: string; key: string }>
  sourceOnly: SourceDriverProfile[]
  legacyOnly: LegacyDriverProfile[]
  collisions: Array<{ legacyDriverId: string; candidateKeys: string[]; reason: string }>
  phoneMultiPark: Array<{ phone: string; parkCodes: ParkCode[]; profileKeys: string[] }>
  incompleteSource: boolean
}

export function reconcileParkIdentity(
  legacyDrivers: LegacyDriverProfile[],
  sourceProfiles: SourceDriverProfile[],
  incompleteParkCodes: ParkCode[] = [],
): ReconciliationResult {
  const sourceByExternalId = new Map<string, SourceDriverProfile[]>()
  const sourceByCompositeKey = new Map<string, SourceDriverProfile>()
  const matchedLegacyIds = new Set<string>()
  const matchedSourceKeys = new Set<string>()
  const exactMatches: ReconciliationResult['exactMatches'] = []
  const collisions: ReconciliationResult['collisions'] = []

  for (const source of sourceProfiles) {
    const key = buildCompositeDriverProfileKey(source.externalParkId, source.externalDriverProfileId)
    sourceByCompositeKey.set(key, source)
    sourceByExternalId.set(source.externalDriverProfileId, [...(sourceByExternalId.get(source.externalDriverProfileId) || []), source])
  }

  for (const legacy of legacyDrivers) {
    const provenKey = legacy.externalParkId && legacy.externalDriverProfileId
      ? buildCompositeDriverProfileKey(legacy.externalParkId, legacy.externalDriverProfileId)
      : null
    if (provenKey && sourceByCompositeKey.has(provenKey)) {
      exactMatches.push({ legacyDriverId: legacy.id, key: provenKey })
      matchedLegacyIds.add(legacy.id)
      matchedSourceKeys.add(provenKey)
      continue
    }

    const candidates = sourceByExternalId.get(legacy.yandexDriverId) || []
    if (candidates.length === 1) {
      const key = buildCompositeDriverProfileKey(candidates[0].externalParkId, candidates[0].externalDriverProfileId)
      exactMatches.push({ legacyDriverId: legacy.id, key })
      matchedLegacyIds.add(legacy.id)
      matchedSourceKeys.add(key)
    } else if (candidates.length > 1) {
      collisions.push({
        legacyDriverId: legacy.id,
        candidateKeys: candidates.map(candidate => buildCompositeDriverProfileKey(candidate.externalParkId, candidate.externalDriverProfileId)),
        reason: 'same externalDriverProfileId appears in multiple parks',
      })
    }
  }

  const sourceOnly = sourceProfiles.filter(source => !matchedSourceKeys.has(buildCompositeDriverProfileKey(source.externalParkId, source.externalDriverProfileId)))
  const legacyOnly = incompleteParkCodes.length > 0 ? [] : legacyDrivers.filter(driver => !matchedLegacyIds.has(driver.id))

  const byPhone = new Map<string, SourceDriverProfile[]>()
  for (const source of sourceProfiles) {
    if (!source.phone) continue
    byPhone.set(source.phone, [...(byPhone.get(source.phone) || []), source])
  }
  const phoneMultiPark = Array.from(byPhone.entries())
    .map(([phone, profiles]) => {
      const parkCodes = Array.from(new Set(profiles.map(profile => profile.parkCode))).sort((a, b) => PARK_CODES.indexOf(a) - PARK_CODES.indexOf(b))
      return {
        phone,
        parkCodes,
        profileKeys: profiles.map(profile => buildCompositeDriverProfileKey(profile.externalParkId, profile.externalDriverProfileId)).sort(),
      }
    })
    .filter(item => item.parkCodes.length > 1)

  return { exactMatches, sourceOnly, legacyOnly, collisions, phoneMultiPark, incompleteSource: incompleteParkCodes.length > 0 }
}

export type MainProfileSource = {
  id: string
  parkCode: ParkCode
  status: 'working' | 'dismissed' | 'unknown'
  manual?: boolean
  externalDriverProfileId: string
}

export type MainProfileSelection = {
  main: MainProfileSource | null
  reason: 'manual' | 'park_priority' | 'no_active_profile'
  anomalies: Array<{ parkCode: ParkCode; activeCount: number; profileIds: string[] }>
}

export function chooseMainParkIdentityProfile(profiles: MainProfileSource[]): MainProfileSelection {
  const active = profiles.filter(profile => profile.status === 'working')
  const byPark = new Map<ParkCode, MainProfileSource[]>()
  for (const profile of active) byPark.set(profile.parkCode, [...(byPark.get(profile.parkCode) || []), profile])
  const anomalies = Array.from(byPark.entries())
    .filter(([, parkProfiles]) => parkProfiles.length > 1)
    .map(([parkCode, parkProfiles]) => ({ parkCode, activeCount: parkProfiles.length, profileIds: parkProfiles.map(profile => profile.id).sort() }))
  const anomalous = new Set(anomalies.map(item => item.parkCode))
  const manual = active.find(profile => profile.manual && !anomalous.has(profile.parkCode))
  if (manual) return { main: manual, reason: 'manual', anomalies }

  const eligible = active
    .filter(profile => !anomalous.has(profile.parkCode))
    .sort((a, b) => {
      const priority = PARK_CODES.indexOf(a.parkCode) - PARK_CODES.indexOf(b.parkCode)
      if (priority !== 0) return priority
      return a.externalDriverProfileId.localeCompare(b.externalDriverProfileId)
    })

  return { main: eligible[0] || null, reason: eligible[0] ? 'park_priority' : 'no_active_profile', anomalies }
}
