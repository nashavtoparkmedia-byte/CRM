import { createHash } from 'node:crypto'

import {
  RECONCILE_YANDEX_FLEET_COMMAND_V1,
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

export function createReconcileYandexFleetHandlerV1(port: YandexFleetReconcilerPortV1) {
  return async (command: ReconcileYandexFleetCommandV1): Promise<ReconcileYandexFleetResultV1> => {
    if (command.contract !== RECONCILE_YANDEX_FLEET_COMMAND_V1) throw new TypeError('unsupported contract')
    return port.reconcile(command)
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
