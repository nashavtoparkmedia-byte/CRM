export const RECONCILE_YANDEX_FLEET_COMMAND_V1 = 'fleet.ReconcileYandexFleetCommand.v1' as const

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
