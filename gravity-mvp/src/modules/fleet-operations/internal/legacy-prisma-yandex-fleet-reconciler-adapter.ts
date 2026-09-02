import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import {
  RECONCILE_YANDEX_FLEET_COMMAND_V1,
  type ReconcileYandexFleetCommandV1,
  type YandexFleetReconciliationModeV1,
} from '@/contracts/fleet-operations/v1'

import { prisma } from '@/lib/prisma'
import {
  persistDriverClusterContradictionV1,
  runDriverClusterContactOwnershipV1,
} from '@/modules/contacts/public/v1'
import {
  RECONCILE_DRIVER_CLUSTER_COMMAND_V1,
  type DriverClusterProfileEvidenceV1,
} from '@/contracts/contacts/v1'
import {
  listYandexConnectionCredentialsV1,
  type YandexConnectionCredentialsV1,
} from '../public/v1/yandex-connection-capability'
import { normalizePhoneE164 } from '@/modules/contacts/public/v1/phone-identity'
import {
  driverFleetEvidenceState,
  withDriverFleetEvidence,
} from '../public/v1/driver-fleet-evidence'
import { canAdoptUnqualifiedLegacyDriverProfileV1 } from '../public/v1/yandex-fleet-reconciler'
import { admitFleetReconciliationTransactionV1 } from '../public/v1/legacy-prisma-contact-merge-adapter'

export { RECONCILE_YANDEX_FLEET_COMMAND_V1 }
export type { ReconcileYandexFleetCommandV1, YandexFleetReconciliationModeV1 }

export type YandexFleetProfileObservationV1 = {
  externalParkId: string
  localParkId: string | null
  sourceConnectionId: string
  externalDriverProfileId: string
  fullName: string
  phones: string[]
  rawPhones: string[]
  rawVu: string | null
  normalizedVu: string | null
  legalRole: string | null
  workStatus: string | null
  currentStatus: string | null
  city: string | null
  profileType: string | null
  sourceDates: Record<string, string | null>
  observedAt: Date
  rawMetadata: Record<string, unknown>
  evidenceRoot: string
}

export type ReconciledDriverClusterV1 = {
  profileClusterKey: string
  normalizedVu: string | null
  contactId: string | null
  contactMergeCandidateIds: string[]
  profileIds: string[]
  profiles: DriverClusterProfileEvidenceV1[]
  warnings: string[]
}

export type ReconcileYandexFleetResultV1 = {
  mode: YandexFleetReconciliationModeV1
  checkedParks: number
  succeededParks: number
  failedParks: number
  profilesObserved: number
  profilesUpserted: number
  clusters: ReconciledDriverClusterV1[]
  errors: Array<{ parkId: string; parkName: string; message: string }>
  partial: boolean
}

export function normalizeDriverLicenceVuV1(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').toUpperCase().replace(/[\s._-]+/g, '')
  if (!/^[0-9A-ZА-ЯЁ]{8,20}$/u.test(normalized)) return null
  // Mixed Latin/Cyrillic values are visually ambiguous (for example A/А).
  // Do not let a lossy guess become strong person evidence.
  if (/[A-Z]/.test(normalized) && /[А-ЯЁ]/u.test(normalized)) return null
  const digitCount = (normalized.match(/\d/g) || []).length
  if (digitCount < 6) return null
  return normalized
}

export function makeParkQualifiedDriverKeyV1(
  externalParkId: string,
  externalDriverProfileId: string,
): string {
  const digest = createHash('sha256')
    .update(`${externalParkId}\0${externalDriverProfileId}`)
    .digest('hex')
    .slice(0, 32)
  return `park-profile:${digest}`
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function yandexFleetProfileObservationV1(
  externalParkId: string,
  localParkId: string | null,
  sourceConnectionId: string,
  value: unknown,
  observedAt = new Date(),
): YandexFleetProfileObservationV1 | null {
  const envelope = value as {
    driver_profile?: Record<string, unknown>
    current_status?: Record<string, unknown>
  }
  const profile = envelope?.driver_profile
  const externalDriverProfileId = stringValue(profile?.id)
  if (!externalDriverProfileId) return null
  const rawPhones = Array.isArray(profile?.phones) ? profile.phones.map(String) : []
  const phones = [...new Set(rawPhones.map(normalizePhoneE164).filter((phone): phone is string => Boolean(phone)))].sort()
  const licenceValue = typeof profile?.driver_license === 'object' && profile.driver_license
    ? stringValue((profile.driver_license as Record<string, unknown>).number)
    : stringValue(profile?.driver_license)
  const fullName = [
    stringValue(profile?.last_name),
    stringValue(profile?.first_name),
    stringValue(profile?.middle_name),
  ].filter(Boolean).join(' ') || 'Без имени'
  const sourceDates = {
    createdDate: stringValue(profile?.created_date),
    modifiedDate: stringValue(profile?.modified_date),
    hireDate: stringValue(profile?.hire_date),
    statusUpdatedAt: stringValue(envelope.current_status?.status_updated_at),
  }
  return {
    externalParkId,
    localParkId,
    sourceConnectionId,
    externalDriverProfileId,
    fullName,
    phones,
    rawPhones,
    rawVu: licenceValue,
    normalizedVu: normalizeDriverLicenceVuV1(licenceValue),
    legalRole: stringValue(profile?.legal_role) ?? stringValue(profile?.work_rule_id),
    workStatus: stringValue(profile?.work_status),
    currentStatus: stringValue(envelope.current_status?.status),
    city: stringValue(profile?.city),
    profileType: stringValue(profile?.profile_type),
    sourceDates,
    observedAt,
    rawMetadata: {
      driverProfile: profile,
      currentStatus: envelope.current_status ?? null,
    },
    evidenceRoot: `yandex:${externalParkId}:${externalDriverProfileId}:${observedAt.toISOString()}`,
  }
}

async function fetchParkProfiles(
  connection: YandexConnectionCredentialsV1,
  query: string | null,
): Promise<YandexFleetProfileObservationV1[]> {
  const observations: YandexFleetProfileObservationV1[] = []
  let offset = 0
  const limit = query ? 100 : 1000
  let total = Number.POSITIVE_INFINITY
  do {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await fetch('https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list', {
        method: 'POST',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'X-Client-ID': connection.clid,
          'X-Api-Key': connection.apiKey,
          'Accept-Language': 'ru',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: {
            park: { id: connection.parkId },
            ...(query ? { text: query } : {}),
          },
          fields: {
            driver_profile: [
              'id',
              'first_name',
              'last_name',
              'middle_name',
              'phones',
              'work_status',
              'created_date',
              'modified_date',
              'hire_date',
              'driver_license',
              'work_rule_id',
            ],
            current_status: ['status', 'status_updated_at'],
            car: [],
            account: [],
          },
          limit,
          offset,
        }),
      })
      if (!response.ok) throw new Error(`Yandex Fleet HTTP ${response.status}`)
      const body = await response.json() as { driver_profiles?: unknown[]; total?: number }
      const rows = Array.isArray(body.driver_profiles) ? body.driver_profiles : []
      total = Number.isFinite(Number(body.total)) ? Number(body.total) : offset + rows.length
      const observedAt = new Date()
      for (const row of rows) {
        const observation = yandexFleetProfileObservationV1(
          connection.parkId,
          connection.localParkId,
          connection.connectionId,
          row,
          observedAt,
        )
        if (observation) observations.push(observation)
      }
      offset += rows.length
      if (query || rows.length === 0) break
    } finally {
      clearTimeout(timeout)
    }
  } while (offset < total)
  return observations
}

async function ensureLocalPark(
  observation: YandexFleetProfileObservationV1,
): Promise<string | null> {
  // Park topology is provisioned by the existing connection authority. A
  // reconciliation run must not invent a Park when that authority is absent.
  return observation.localParkId
}

export async function upsertObservation(
  observation: YandexFleetProfileObservationV1,
  configuredParkCount: number,
): Promise<{ driverId: string; observation: YandexFleetProfileObservationV1 } | null> {
  const result = await prisma.$transaction(async transaction => {
    const parkId = await ensureLocalPark(observation)
    const composite = await transaction.driver.findUnique({
      where: {
        externalParkId_externalDriverProfileId: {
          externalParkId: observation.externalParkId,
          externalDriverProfileId: observation.externalDriverProfileId,
        },
      },
      select: { id: true, contactId: true, yandexDriverId: true, licenseNumber: true, customFields: true },
    })
    const unqualifiedLegacy = composite ? null : await transaction.driver.findFirst({
      where: {
        yandexDriverId: observation.externalDriverProfileId,
        externalParkId: null,
        externalDriverProfileId: null,
      },
      select: { id: true, contactId: true, yandexDriverId: true, licenseNumber: true, customFields: true },
    })
    // A provider profile id is not globally unique across parks. Preserve the
    // legacy row when several parks are configured; the qualified observation
    // becomes a separate profile and is fenced as a reconciliation conflict.
    const mayAdoptLegacy = canAdoptUnqualifiedLegacyDriverProfileV1(configuredParkCount)
    const unsafeLegacyCollision = mayAdoptLegacy ? null : unqualifiedLegacy
    const legacy = composite ?? (mayAdoptLegacy ? unqualifiedLegacy : null)
    const previousNormalizedVu = normalizeDriverLicenceVuV1(legacy?.licenseNumber)
    const authoritativeContradiction = Boolean(
      previousNormalizedVu
        && observation.normalizedVu
        && previousNormalizedVu !== observation.normalizedVu,
    )
    const previousFleetEvidence = driverFleetEvidenceState(legacy?.customFields)
    const previousObservedAt = previousFleetEvidence.lastObservedAt
      ? new Date(previousFleetEvidence.lastObservedAt)
      : null
    if (legacy && previousObservedAt && !Number.isNaN(previousObservedAt.getTime())
      && previousObservedAt.getTime() >= observation.observedAt.getTime()) {
      return {
        ignoredAsStale: true as const,
        driverId: legacy.id,
        observation,
        conflictContactId: null,
        conflictBasis: null,
      }
    }
    const previousMetadata = previousFleetEvidence.sourceMetadata
    const licenseHistory = Array.isArray(previousMetadata.licenseHistory) ? previousMetadata.licenseHistory : []
    const nextLicenseHistory = observation.rawVu && (
      previousNormalizedVu !== observation.normalizedVu || legacy?.licenseNumber !== observation.rawVu
    )
      ? [...licenseHistory.map(item => (
          item && typeof item === 'object' && !Array.isArray(item) && (item as Prisma.JsonObject).status === 'current'
            ? { ...(item as Prisma.JsonObject), status: 'superseded', supersededAt: observation.observedAt.toISOString() }
            : item
        )), {
          rawValue: observation.rawVu,
          normalizedValue: observation.normalizedVu,
          provenance: 'yandex_fleet',
          evidenceRoot: observation.evidenceRoot,
          observedAt: observation.observedAt.toISOString(),
          status: 'current',
        }].slice(-50)
      : licenseHistory
    const data = {
      externalParkId: observation.externalParkId,
      externalDriverProfileId: observation.externalDriverProfileId,
      parkId,
      sourceConnectionId: observation.sourceConnectionId,
      fullName: observation.fullName,
      phone: observation.phones[0] ?? null,
      licenseNumber: observation.rawVu,
      customFields: withDriverFleetEvidence(legacy?.customFields, {
        legalRole: observation.legalRole,
        workStatus: observation.workStatus,
        currentStatus: observation.currentStatus,
        sourceStatus: observation.currentStatus ?? observation.workStatus,
        sourceCity: observation.city,
        sourceProfileType: observation.profileType,
        sourcePhones: observation.rawPhones,
        sourceDates: observation.sourceDates,
        lastObservedAt: observation.observedAt.toISOString(),
        lastSynchronizedAt: new Date().toISOString(),
        sourceFreshness: 'fresh',
        sourceState: 'current',
        sourceMetadata: {
          ...previousMetadata,
          sourceObservation: observation.rawMetadata,
          licenseHistory: nextLicenseHistory,
          ...(authoritativeContradiction ? {
            authoritativeContradiction: {
              type: 'authoritative_vu_change',
              previousNormalizedVu,
              observedNormalizedVu: observation.normalizedVu,
              rawVu: observation.rawVu,
              evidenceRoot: observation.evidenceRoot,
              detectedAt: observation.observedAt.toISOString(),
            },
          } : {}),
        },
      }) as Prisma.InputJsonObject,
      externalPersonKey: observation.normalizedVu ? `vu:${observation.normalizedVu}` : null,
      personKeyType: observation.normalizedVu ? 'normalized_vu' : null,
      ...(authoritativeContradiction ? {
        personResolutionStatus: 'conflict',
        personResolutionBasis: 'authoritative_vu_change',
        personResolutionAt: observation.observedAt,
        personResolvedBy: 'fleet-reconciler',
      } : {}),
    }
    const driver = legacy
      ? await transaction.driver.update({
          where: { id: legacy.id },
          data,
          select: { id: true },
        })
      : await transaction.driver.create({
          data: {
            ...data,
            yandexDriverId: makeParkQualifiedDriverKeyV1(
              observation.externalParkId,
              observation.externalDriverProfileId,
            ),
            personResolutionStatus: unsafeLegacyCollision
              ? 'conflict'
              : observation.normalizedVu ? 'vu_observed' : 'unlinked',
            ...(unsafeLegacyCollision ? {
              personResolutionBasis: 'legacy_unqualified_provider_id',
              personResolutionAt: observation.observedAt,
              personResolvedBy: 'fleet-reconciler',
            } : {}),
          },
          select: { id: true },
        })

    return {
      ignoredAsStale: false as const,
      driverId: driver.id,
      observation,
      conflictContactId: authoritativeContradiction
        ? legacy?.contactId ?? null
        : unsafeLegacyCollision?.contactId ?? null,
      conflictBasis: authoritativeContradiction
        ? 'authoritative_vu_change'
        : unsafeLegacyCollision ? 'legacy_unqualified_provider_id' : null,
    }
  })
  if (result.ignoredAsStale) return null
  if (result.conflictContactId) {
    await persistDriverClusterContradictionV1({
      profileClusterKey: clusterKeyFor(result),
      contactIds: [result.conflictContactId],
      driverIds: [result.driverId],
      evidenceRoot: `${result.conflictBasis}:${observation.evidenceRoot}`,
    })
  }
  return { driverId: result.driverId, observation: result.observation }
}

function clusterKeyFor(
  row: { driverId: string; observation: YandexFleetProfileObservationV1 },
): string {
  return row.observation.normalizedVu
    ? `vu:${row.observation.normalizedVu}`
    : `profile:${row.observation.externalParkId}:${row.observation.externalDriverProfileId}`
}

async function withFleetReconciliationMutationLease<T>(work: () => Promise<T>): Promise<T> {
  return prisma.$transaction(async transaction => {
    await admitFleetReconciliationTransactionV1(transaction)
    return work()
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 10_000,
    timeout: 240_000,
  })
}

async function updateDriverClusterContactLink(transaction: Prisma.TransactionClient, input: {
  driverIds: string[]
  contactId: string
  status: string
  basis: string
  onlyUnlinked: boolean
}): Promise<string> {
  let canonicalId = input.contactId
  for (let depth = 0; depth < 16; depth += 1) {
    const contact = await transaction.contact.findUnique({
      where: { id: canonicalId },
      select: { isArchived: true, customFields: true },
    })
    if (!contact) throw new Error('DRIVER_CLUSTER_CONTACT_NOT_FOUND')
    if (!contact.isArchived) break
    const fields = contact.customFields && typeof contact.customFields === 'object'
      && !Array.isArray(contact.customFields)
      ? contact.customFields as Record<string, unknown>
      : {}
    if (typeof fields.mergedIntoContactId !== 'string' || fields.mergedIntoContactId === canonicalId) {
      throw new Error('DRIVER_CLUSTER_CONTACT_ARCHIVED')
    }
    canonicalId = fields.mergedIntoContactId
  }
  const canonical = await transaction.contact.findUnique({
    where: { id: canonicalId },
    select: { isArchived: true },
  })
  if (!canonical || canonical.isArchived) throw new Error('DRIVER_CLUSTER_CONTACT_ARCHIVED')
  await transaction.driver.updateMany({
    where: {
      id: { in: input.driverIds },
      ...(input.onlyUnlinked ? { contactId: null } : {}),
    },
    data: {
      contactId: canonicalId,
      personResolutionStatus: input.status,
      personResolutionBasis: input.basis,
      personResolutionAt: new Date(),
      personResolvedBy: 'fleet-reconciler',
    },
  })
  return canonicalId
}

export async function reconcileClusters(
  rows: Array<{ driverId: string; observation: YandexFleetProfileObservationV1 }>,
): Promise<ReconciledDriverClusterV1[]> {
  const grouped = new Map<string, typeof rows>()
  for (const row of rows) {
    const key = clusterKeyFor(row)
    grouped.set(key, [...(grouped.get(key) ?? []), row])
  }
  const clusters: ReconciledDriverClusterV1[] = []
  for (const [profileClusterKey, observedMembers] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const cluster = await runDriverClusterContactOwnershipV1(contactRepository => (
      prisma.$transaction(async transaction => {
      // The Contacts owner holds CNT1 while this Fleet transaction re-reads
      // the complete Driver cluster, derives Contact evidence, and links it.
      const observedById = new Map(observedMembers.map(member => [member.driverId, member.observation]))
      const persisted = await transaction.driver.findMany({
        where: profileClusterKey.startsWith('vu:')
          ? { externalPersonKey: profileClusterKey }
          : { id: { in: observedMembers.map(member => member.driverId) } },
        select: {
          id: true,
          externalParkId: true,
          externalDriverProfileId: true,
          sourceConnectionId: true,
          fullName: true,
          phone: true,
          licenseNumber: true,
          customFields: true,
          contactId: true,
          personResolutionStatus: true,
        },
      })
      const members = persisted.map(row => {
        const observed = observedById.get(row.id)
        if (observed) return { driverId: row.id, observation: observed, sourceFreshness: 'fresh' as const }
        const evidence = driverFleetEvidenceState(row.customFields)
        const lastObservedAt = evidence.lastObservedAt ? new Date(evidence.lastObservedAt) : new Date(0)
        const observation: YandexFleetProfileObservationV1 = {
          externalParkId: row.externalParkId ?? 'legacy',
          localParkId: null,
          sourceConnectionId: row.sourceConnectionId ?? 'legacy',
          externalDriverProfileId: row.externalDriverProfileId ?? row.id,
          fullName: row.fullName,
          phones: [...new Set([
            ...evidence.sourcePhones.map(normalizePhoneE164).filter((phone): phone is string => Boolean(phone)),
            ...(normalizePhoneE164(row.phone) ? [normalizePhoneE164(row.phone)!] : []),
          ])].sort(),
          rawPhones: evidence.sourcePhones,
          rawVu: row.licenseNumber,
          normalizedVu: normalizeDriverLicenceVuV1(row.licenseNumber),
          legalRole: evidence.legalRole,
          workStatus: evidence.workStatus,
          currentStatus: evidence.currentStatus,
          city: evidence.sourceCity,
          profileType: evidence.sourceProfileType,
          sourceDates: evidence.sourceDates,
          observedAt: Number.isNaN(lastObservedAt.getTime()) ? new Date(0) : lastObservedAt,
          rawMetadata: evidence.sourceMetadata,
          evidenceRoot: `persisted:${row.id}:${evidence.lastObservedAt ?? 'unknown'}`,
        }
        return { driverId: row.id, observation, sourceFreshness: evidence.sourceFreshness }
      })
      if (members.length === 0) throw new Error('DRIVER_CLUSTER_EMPTY_AFTER_ADMISSION')
      const profiles: DriverClusterProfileEvidenceV1[] = members.map(member => ({
        driverId: member.driverId,
        externalParkId: member.observation.externalParkId,
        externalDriverProfileId: member.observation.externalDriverProfileId,
        fullName: member.observation.fullName,
        phones: member.observation.phones,
        normalizedVu: member.observation.normalizedVu,
        evidenceRoot: member.observation.evidenceRoot,
        sourceFreshness: member.sourceFreshness,
        legalRole: member.observation.legalRole,
        status: member.observation.currentStatus ?? member.observation.workStatus,
        workStatus: member.observation.workStatus,
        currentStatus: member.observation.currentStatus,
        city: member.observation.city,
        profileType: member.observation.profileType,
        rawVu: member.observation.rawVu,
        sourceDates: member.observation.sourceDates,
      }))
      const decision = await contactRepository.reconcile({
        contract: RECONCILE_DRIVER_CLUSTER_COMMAND_V1,
        profileClusterKey,
        profiles,
      })
      const existingContactIds = [...new Set(persisted
        .map(row => row.contactId)
        .filter((id): id is string => Boolean(id)))].sort()
      const warnings: string[] = []
      let contactId: string | null = null
      let contactMergeCandidateIds: string[] = []
      const driverIds = members.map(member => member.driverId)
      const evidenceRoot = profiles.map(profile => profile.evidenceRoot).sort().join('|')
      const incompleteClusterEvidence = members.some(member => member.sourceFreshness !== 'fresh')
      const deferExactPairToContacts = (contactIds: string[]): boolean => {
        const candidateIds = [...new Set(contactIds)].sort()
        if (candidateIds.length !== 2) return false
        contactMergeCandidateIds = candidateIds
        warnings.push('contact_auto_merge_candidate')
        return true
      }
      if (persisted.some(row => row.personResolutionStatus === 'conflict')) {
        warnings.push('authoritative_source_contradiction')
      } else if (decision.status === 'conflict') {
        if (!deferExactPairToContacts(decision.contactIds)) {
          warnings.push('contact_phone_ambiguity')
          await contactRepository.persistContradiction({
            profileClusterKey,
            contactIds: decision.contactIds,
            driverIds,
            evidenceRoot,
          })
        }
      } else if (decision.status === 'link') {
        contactId = decision.contactId
        if (existingContactIds.some(id => id !== contactId)) {
          const conflictingContactIds = [...new Set([...existingContactIds, contactId])]
          if (!deferExactPairToContacts(conflictingContactIds)) {
            warnings.push('confirmed_person_contradiction')
            await contactRepository.persistContradiction({
              profileClusterKey,
              contactIds: conflictingContactIds,
              driverIds,
              evidenceRoot,
            })
          }
          contactId = null
        } else if (incompleteClusterEvidence && existingContactIds.length === 0) {
          warnings.push('partial_cluster_evidence')
          contactId = null
        } else {
          contactId = await updateDriverClusterContactLink(transaction, {
            driverIds,
            contactId,
            status: decision.basis === 'operator_confirmation' ? 'operator_confirmed' : 'phone_linked',
            basis: decision.basis,
            onlyUnlinked: false,
          })
        }
      } else if (existingContactIds.length === 1) {
        contactId = existingContactIds[0]
        if (incompleteClusterEvidence) {
          warnings.push('partial_cluster_evidence')
        } else {
          contactId = await updateDriverClusterContactLink(transaction, {
            driverIds,
            contactId,
            status: 'vu_clustered',
            basis: 'normalized_vu',
            onlyUnlinked: true,
          })
        }
      } else if (existingContactIds.length > 1) {
        if (!deferExactPairToContacts(existingContactIds)) {
          warnings.push('vu_contact_contradiction')
          await contactRepository.persistContradiction({
            profileClusterKey,
            contactIds: existingContactIds,
            driverIds,
            evidenceRoot,
          })
          await transaction.driver.updateMany({
            where: { id: { in: driverIds } },
            data: { personResolutionStatus: 'conflict', personResolutionBasis: 'normalized_vu_contradiction' },
          })
        }
      } else if (members[0].observation.normalizedVu && members.length > 1 && !incompleteClusterEvidence) {
        await transaction.driver.updateMany({
          where: { id: { in: driverIds } },
          data: {
            personResolutionStatus: 'vu_clustered',
            personResolutionBasis: 'normalized_vu',
            personResolutionAt: new Date(),
            personResolvedBy: 'fleet-reconciler',
          },
        })
      } else if (incompleteClusterEvidence) {
        warnings.push('partial_cluster_evidence')
      }
      return {
        profileClusterKey,
        normalizedVu: members[0].observation.normalizedVu,
        contactId,
        contactMergeCandidateIds,
        profileIds: driverIds.sort(),
        profiles,
        warnings,
      }
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 2_000,
        timeout: 15_000,
      })
    ))
    clusters.push(cluster)
  }
  return clusters
}

async function recordParkReconciliationOutcome(
  connection: YandexConnectionCredentialsV1,
  startedAt: number,
  error: string | null,
): Promise<void> {
  await prisma.apiLog.create({
    data: {
      connectionId: connection.connectionId,
      method: 'POST',
      requestUrl: 'https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list',
      requestBody: null,
      responseBody: null,
      statusCode: error ? 0 : 200,
      error: error?.slice(0, 1000) ?? null,
      durationMs: Math.max(0, Date.now() - startedAt),
    },
  }).catch(() => undefined)
}

async function reconcileYandexFleetV1(
  command: ReconcileYandexFleetCommandV1,
): Promise<ReconcileYandexFleetResultV1> {
  if (command.contract !== RECONCILE_YANDEX_FLEET_COMMAND_V1) throw new TypeError('unsupported contract')
  const reconciliationStartedAt = new Date()
  const query = command.query?.trim() || null
  const connections = await listYandexConnectionCredentialsV1()
  const errors: ReconcileYandexFleetResultV1['errors'] = []
  const observations: YandexFleetProfileObservationV1[] = []
  const failedConnections: YandexConnectionCredentialsV1[] = []
  for (const connection of connections) {
    const startedAt = Date.now()
    try {
      observations.push(...await fetchParkProfiles(connection, query))
      await recordParkReconciliationOutcome(connection, startedAt, null)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Yandex Fleet request failed'
      errors.push({ parkId: connection.parkId, parkName: connection.name || connection.parkId, message })
      failedConnections.push(connection)
      await recordParkReconciliationOutcome(connection, startedAt, message)
      // Preserve every last-good source value while exposing stale provenance.
      // A failed absence is not evidence of termination or a different person.
    }
  }
  const { upserted, clusters } = await withFleetReconciliationMutationLease(async () => {
    for (const connection of failedConnections) {
      const staleDrivers = await prisma.driver.findMany({
        where: { sourceConnectionId: connection.connectionId },
        select: { id: true, customFields: true },
      })
      for (const driver of staleDrivers) {
        const evidence = driverFleetEvidenceState(driver.customFields)
        const lastObservedAt = evidence.lastObservedAt ? new Date(evidence.lastObservedAt) : null
        if (lastObservedAt && !Number.isNaN(lastObservedAt.getTime())
          && lastObservedAt.getTime() > reconciliationStartedAt.getTime()) {
          continue
        }
        await prisma.driver.update({
          where: { id: driver.id },
          data: {
            customFields: withDriverFleetEvidence(driver.customFields, {
              ...evidence,
              sourceFreshness: 'stale',
              sourceState: 'stale',
            }) as Prisma.InputJsonObject,
          },
        })
      }
    }
    const upserted: Array<{ driverId: string; observation: YandexFleetProfileObservationV1 }> = []
    for (const observation of observations) {
      const applied = await upsertObservation(observation, connections.length)
      if (applied) upserted.push(applied)
    }
    return { upserted, clusters: await reconcileClusters(upserted) }
  })
  return {
    mode: command.mode,
    checkedParks: connections.length,
    succeededParks: connections.length - errors.length,
    failedParks: errors.length,
    profilesObserved: observations.length,
    profilesUpserted: upserted.length,
    clusters,
    errors,
    partial: errors.length > 0,
  }
}

export const legacyPrismaYandexFleetReconcilerPortV1 = {
  reconcile: reconcileYandexFleetV1,
}
