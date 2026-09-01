import {
  RECOVER_AUTOMATED_CONTACT_MERGE_RESULT_V1,
  parseRecoverAutomatedContactMergeCommandV1,
  type RecoverAutomatedContactMergeCommandV1,
  type RecoverAutomatedContactMergeResultV1,
} from '@/contracts/contacts/v1'

export type AutomatedMergeRecoveryPlanV1 = {
  mergeId: string
  mergedId: string
  survivorId: string
  identityIds: string[]
  phoneIds: string[]
  chatIds: string[]
  taskIds: string[]
  callIds: string[]
  driverProfileIds: string[]
}

export type AutomatedMergeRecoveryInspectionV1 =
  | { status: 'eligible'; plan: AutomatedMergeRecoveryPlanV1 }
  | { status: 'blocked'; reason: string }

export interface AutomatedMergeRecoveryContactsRepositoryV1 {
  /** Must be the first database action in the transaction. */
  admitOwnershipMutation(): Promise<void>
  discoverPair(mergeId: string): Promise<{ mergedId: string; survivorId: string } | null>
  lockPair(mergedId: string, survivorId: string): Promise<void>
  inspect(mergeId: string): Promise<AutomatedMergeRecoveryInspectionV1>
  restore(plan: AutomatedMergeRecoveryPlanV1): Promise<void>
  markManualReconciliation(input: {
    mergeId: string
    requestedBy: string
    basis: string
    reason: string
  }): Promise<void>
  markRecovered(input: {
    mergeId: string
    mergedId: string
    survivorId: string
    requestedBy: string
    basis: string
  }): Promise<void>
  verifyPostconditions(): Promise<void>
}

export interface AutomatedMergeRecoveryOwnerRepositoryV1 {
  canRestore(plan: AutomatedMergeRecoveryPlanV1): Promise<boolean>
  restore(plan: AutomatedMergeRecoveryPlanV1): Promise<void>
}

export type AutomatedMergeRecoveryRepositoriesV1 = {
  contacts: AutomatedMergeRecoveryContactsRepositoryV1
  messaging: AutomatedMergeRecoveryOwnerRepositoryV1
  work: AutomatedMergeRecoveryOwnerRepositoryV1
}

export interface AutomatedMergeRecoveryUnitOfWorkV1 {
  run<T>(operation: (repositories: AutomatedMergeRecoveryRepositoriesV1) => Promise<T>): Promise<T>
}

export function createRecoverAutomatedContactMergeHandlerV1(
  unitOfWork: AutomatedMergeRecoveryUnitOfWorkV1,
) {
  return async function recoverAutomatedContactMergeV1(
    command: RecoverAutomatedContactMergeCommandV1 | unknown,
  ): Promise<RecoverAutomatedContactMergeResultV1> {
    const parsed = parseRecoverAutomatedContactMergeCommandV1(command)
    return unitOfWork.run(async repositories => {
      const { contacts } = repositories
      await contacts.admitOwnershipMutation()
      const pair = await contacts.discoverPair(parsed.mergeId)
      if (!pair) throw new Error(`Contact merge ${parsed.mergeId} not found`)
      await contacts.lockPair(pair.mergedId, pair.survivorId)
      const inspection = await contacts.inspect(parsed.mergeId)
      if (inspection.status === 'blocked') {
        await contacts.markManualReconciliation({
          mergeId: parsed.mergeId,
          requestedBy: parsed.requestedBy,
          basis: parsed.basis,
          reason: inspection.reason,
        })
        return {
          contract: RECOVER_AUTOMATED_CONTACT_MERGE_RESULT_V1,
          status: 'manual_reconciliation',
          mergeId: parsed.mergeId,
          reason: inspection.reason,
        }
      }

      const plan = inspection.plan
      for (const [owner, repository] of Object.entries({
        messaging: repositories.messaging,
        work: repositories.work,
      })) {
        if (!await repository.canRestore(plan)) {
          const reason = `${owner}_state_changed`
          await contacts.markManualReconciliation({
            mergeId: parsed.mergeId,
            requestedBy: parsed.requestedBy,
            basis: parsed.basis,
            reason,
          })
          return {
            contract: RECOVER_AUTOMATED_CONTACT_MERGE_RESULT_V1,
            status: 'manual_reconciliation',
            mergeId: parsed.mergeId,
            reason,
          }
        }
      }

      await repositories.messaging.restore(plan)
      await repositories.work.restore(plan)
      await contacts.restore(plan)
      await contacts.markRecovered({
        mergeId: parsed.mergeId,
        mergedId: plan.mergedId,
        survivorId: plan.survivorId,
        requestedBy: parsed.requestedBy,
        basis: parsed.basis,
      })
      await contacts.verifyPostconditions()
      return {
        contract: RECOVER_AUTOMATED_CONTACT_MERGE_RESULT_V1,
        status: 'recovered',
        mergeId: parsed.mergeId,
      }
    })
  }
}
