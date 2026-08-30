import {
    ContractValidationError,
    CREATE_IDEMPOTENT_TASK_COMMAND_V1,
    TaskIdempotencyConflictError,
} from '@/contracts/work-management/v1'
import { createIdempotentTaskV1 } from '@/modules/work-management/public/v1'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import { aiCallFinalizationPrismaPort } from '../internal/ai-calls/ai-call-finalization-prisma-adapter'
import {
    createAiCallFinalizationRecoveryByIdentityOperation,
    type IdempotentTaskCommandPort,
} from './ai-call-finalization'

const taskPort: IdempotentTaskCommandPort = {
    async create(command) {
        return createIdempotentTaskV1({
            contract: CREATE_IDEMPOTENT_TASK_COMMAND_V1,
            idempotencyKey: command.idempotencyKey,
            data: command.data,
        })
    },
    isPermanentError(error: unknown) {
        return error instanceof ContractValidationError || error instanceof TaskIdempotencyConflictError
    },
}

const recoverByIdentity = createAiCallFinalizationRecoveryByIdentityOperation({
    persistence: aiCallFinalizationPrismaPort,
    tasks: taskPort,
})

export async function recoverAiCallFinalizationFollowUpByIdentity(
    callId: string,
    fingerprint: string,
): Promise<void> {
    const result = await recoverByIdentity(callId, fingerprint)
    if (result.kind === 'retryable') {
        throw new Error(`AI_CALL_FINALIZATION_FOLLOW_UP_RETRYABLE:${result.followUpStatus}`)
    }
    if (result.kind === 'terminal_failure') {
        opsLog('error', 'ai_call_finalization_follow_up_terminal_failure', {
            callId,
            code: result.failure.code,
        })
        return
    }
    if (result.kind !== 'success') {
        throw new Error(`AI_CALL_FINALIZATION_RECOVERY_IDENTITY_REJECTED:${result.kind}`)
    }
    opsLog('info', 'ai_call_finalization_follow_up_recovered', {
        callId,
        followUpStatus: result.followUpStatus,
    })
}
