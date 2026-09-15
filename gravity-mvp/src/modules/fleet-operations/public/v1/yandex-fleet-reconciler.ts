import { createHash } from 'node:crypto'

import {
  RECONCILE_YANDEX_FLEET_COMMAND_V1,
  parseReconcileYandexFleetCommandV1,
  type ReconcileYandexFleetCommandV1,
  type YandexFleetReconciliationModeV1,
} from '@/contracts/fleet-operations/v1'
import type { DriverClusterProfileEvidenceV1 } from '@/contracts/contacts/v1'
import { normalizePhoneE164 } from '@/modules/contacts/public/v1/phone-identity'

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
  /** Exact two-Contact ownership ambiguity, eligible only for Contacts policy evaluation. */
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

export interface YandexFleetReconcilerPortV1 {
  reconcile(command: ReconcileYandexFleetCommandV1): Promise<ReconcileYandexFleetResultV1>
}

export type YandexFleetReconciliationRunnerV1 = (
  command: ReconcileYandexFleetCommandV1 | unknown,
) => Promise<ReconcileYandexFleetResultV1>

declare global {
  // Platform Shell supplies the cross-owner coordinator during application
  // bootstrap. Fleet owns the port and snapshots it once per sync run.
  var __yandexFleetReconciliationRunnerV1: YandexFleetReconciliationRunnerV1 | undefined
}

/**
 * Bind the application-level reconciliation runner without introducing a
 * Fleet -> Platform Shell import. Registration is stable and idempotent for
 * the same function; a competing composition fails closed.
 */
export function registerYandexFleetReconciliationRunnerV1(
  runner: YandexFleetReconciliationRunnerV1,
): () => void {
  if (typeof runner !== 'function') throw new TypeError('runner must be a function')
  const existing = globalThis.__yandexFleetReconciliationRunnerV1
  if (existing && existing !== runner) {
    throw new Error('YANDEX_FLEET_RECONCILIATION_RUNNER_ALREADY_REGISTERED')
  }
  globalThis.__yandexFleetReconciliationRunnerV1 = runner
  return () => {
    if (globalThis.__yandexFleetReconciliationRunnerV1 === runner) {
      globalThis.__yandexFleetReconciliationRunnerV1 = undefined
    }
  }
}

/** No raw fallback: missing application composition must remain visible. */
export function requireYandexFleetReconciliationRunnerV1(): YandexFleetReconciliationRunnerV1 {
  const runner = globalThis.__yandexFleetReconciliationRunnerV1
  if (!runner) throw new Error('YANDEX_FLEET_RECONCILIATION_RUNNER_NOT_REGISTERED')
  return runner
}

export function createReconcileYandexFleetHandlerV1(port: YandexFleetReconcilerPortV1) {
  return async (command: ReconcileYandexFleetCommandV1 | unknown): Promise<ReconcileYandexFleetResultV1> => {
    const parsed = parseReconcileYandexFleetCommandV1(command)
    return port.reconcile(parsed)
  }
}

export function normalizeDriverLicenceVuV1(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').toUpperCase().replace(/[\s._-]+/g, '')
  if (!/^[0-9A-ZА-ЯЁ]{8,20}$/u.test(normalized)) return null
  if (/[A-Z]/.test(normalized) && /[А-ЯЁ]/u.test(normalized)) return null
  if ((normalized.match(/\d/g) || []).length < 6) return null
  return normalized
}

export function makeParkQualifiedDriverKeyV1(externalParkId: string, externalDriverProfileId: string): string {
  const digest = createHash('sha256')
    .update(`${externalParkId}\0${externalDriverProfileId}`)
    .digest('hex')
    .slice(0, 32)
  return `park-profile:${digest}`
}

/** An unqualified legacy provider id is adoptable only in a one-park topology. */
export function canAdoptUnqualifiedLegacyDriverProfileV1(configuredParkCount: number): boolean {
  return configuredParkCount === 1
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
  const envelope = value as { driver_profile?: Record<string, unknown>; current_status?: Record<string, unknown> }
  const profile = envelope?.driver_profile
  const externalDriverProfileId = stringValue(profile?.id)
  if (!externalDriverProfileId) return null
  const rawPhones = Array.isArray(profile?.phones) ? profile.phones.map(String) : []
  const phones = [...new Set(rawPhones.map(normalizePhoneE164).filter((phone): phone is string => Boolean(phone)))].sort()
  const licenceValue = typeof profile?.driver_license === 'object' && profile.driver_license
    ? stringValue((profile.driver_license as Record<string, unknown>).number)
    : stringValue(profile?.driver_license)
  const fullName = [stringValue(profile?.last_name), stringValue(profile?.first_name), stringValue(profile?.middle_name)]
    .filter(Boolean).join(' ') || 'Без имени'
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
    rawMetadata: { driverProfile: profile, currentStatus: envelope.current_status ?? null },
    evidenceRoot: `yandex:${externalParkId}:${externalDriverProfileId}:${observedAt.toISOString()}`,
  }
}
