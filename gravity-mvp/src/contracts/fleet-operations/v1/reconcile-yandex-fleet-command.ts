export const RECONCILE_YANDEX_FLEET_COMMAND_V1 = 'fleet_operations.ReconcileYandexFleetCommand.v1' as const

export type YandexFleetReconciliationModeV1 =
  | 'nightly'
  | 'manual'
  | 'contact_refresh'
  | 'confirmation_followup'

export type ReconcileYandexFleetCommandV1 = {
  contract: typeof RECONCILE_YANDEX_FLEET_COMMAND_V1
  mode: YandexFleetReconciliationModeV1
  query?: string | null
}

export class ReconcileYandexFleetCommandValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: ReconcileYandexFleetCommandValidationError['code'], message: string) {
    super(message)
    this.name = 'ReconcileYandexFleetCommandValidationError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new ReconcileYandexFleetCommandValidationError('INVALID_CONTRACT', message)
}

export function parseReconcileYandexFleetCommandV1(input: unknown): ReconcileYandexFleetCommandV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('command must be an object')
  const value = input as Record<string, unknown>
  if (value.contract !== RECONCILE_YANDEX_FLEET_COMMAND_V1) {
    if (typeof value.contract === 'string'
      && value.contract.startsWith('fleet_operations.ReconcileYandexFleetCommand.')) {
      throw new ReconcileYandexFleetCommandValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${value.contract}`,
      )
    }
    invalid(`contract must equal ${RECONCILE_YANDEX_FLEET_COMMAND_V1}`)
  }
  const supported = ['contract', 'mode', 'query']
  const extra = Object.keys(value).filter(key => !supported.includes(key))
  if (extra.length > 0) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)
  if (typeof value.mode !== 'string'
    || !['nightly', 'manual', 'contact_refresh', 'confirmation_followup'].includes(value.mode)) {
    invalid('mode is unsupported')
  }
  if (value.query !== undefined && value.query !== null && typeof value.query !== 'string') {
    invalid('query must be a string or null')
  }
  return value as ReconcileYandexFleetCommandV1
}
