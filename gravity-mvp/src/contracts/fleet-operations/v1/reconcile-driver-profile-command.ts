export const RECONCILE_DRIVER_PROFILE_COMMAND_V1 = 'fleet_operations.ReconcileDriverProfileCommand.v1' as const
export const RECONCILE_DRIVER_PROFILE_RESULT_V1 = 'fleet_operations.ReconcileDriverProfileResult.v1' as const

export interface ReconcileDriverProfileCommandV1 {
  contract: typeof RECONCILE_DRIVER_PROFILE_COMMAND_V1
  yandexDriverId: string
  fullName: string
  lastOrderAt: Date | null
}

export interface ReconcileDriverProfileResultV1 {
  contract: typeof RECONCILE_DRIVER_PROFILE_RESULT_V1
  reconciled: true
}

export class ReconcileDriverProfileValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
  constructor(code: ReconcileDriverProfileValidationError['code'], message: string) {
    super(message)
    this.name = 'ReconcileDriverProfileValidationError'
    this.code = code
  }
}

export function parseReconcileDriverProfileCommandV1(input: unknown): ReconcileDriverProfileCommandV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ReconcileDriverProfileValidationError('INVALID_CONTRACT', 'command must be an object')
  const value = input as Record<string, unknown>
  const extra = Object.keys(value).filter(key => !['contract', 'yandexDriverId', 'fullName', 'lastOrderAt'].includes(key))
  if (extra.length) throw new ReconcileDriverProfileValidationError('INVALID_CONTRACT', `unsupported field(s): ${extra.sort().join(', ')}`)
  if (value.contract !== RECONCILE_DRIVER_PROFILE_COMMAND_V1) {
    if (typeof value.contract === 'string' && value.contract.startsWith('fleet_operations.ReconcileDriverProfileCommand.')) throw new ReconcileDriverProfileValidationError('UNSUPPORTED_CONTRACT_VERSION', `unsupported contract version: ${value.contract}`)
    throw new ReconcileDriverProfileValidationError('INVALID_CONTRACT', `contract must equal ${RECONCILE_DRIVER_PROFILE_COMMAND_V1}`)
  }
  if (typeof value.yandexDriverId !== 'string' || !value.yandexDriverId.trim()) throw new ReconcileDriverProfileValidationError('INVALID_CONTRACT', 'yandexDriverId is required')
  if (typeof value.fullName !== 'string' || !value.fullName.trim()) throw new ReconcileDriverProfileValidationError('INVALID_CONTRACT', 'fullName is required')
  if (value.lastOrderAt !== null && !(value.lastOrderAt instanceof Date) || value.lastOrderAt instanceof Date && !Number.isFinite(value.lastOrderAt.getTime())) throw new ReconcileDriverProfileValidationError('INVALID_CONTRACT', 'lastOrderAt must be a valid Date or null')
  return input as ReconcileDriverProfileCommandV1
}
