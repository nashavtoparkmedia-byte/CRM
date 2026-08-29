import { RECONCILE_DRIVER_PROFILE_RESULT_V1, parseReconcileDriverProfileCommandV1, type ReconcileDriverProfileCommandV1, type ReconcileDriverProfileResultV1 } from '../../../../contracts/fleet-operations/v1'

export interface ReconcileDriverProfilePersistencePortV1 {
  reconcile(input: { yandexDriverId: string; fullName: string; lastOrderAt: Date | null }): Promise<void>
}

export function createReconcileDriverProfileHandlerV1(port: ReconcileDriverProfilePersistencePortV1) {
  return async function reconcileDriverProfileV1(command: ReconcileDriverProfileCommandV1 | unknown): Promise<ReconcileDriverProfileResultV1> {
    const parsed = parseReconcileDriverProfileCommandV1(command)
    await port.reconcile({ yandexDriverId: parsed.yandexDriverId, fullName: parsed.fullName, lastOrderAt: parsed.lastOrderAt })
    return { contract: RECONCILE_DRIVER_PROFILE_RESULT_V1, reconciled: true }
  }
}
