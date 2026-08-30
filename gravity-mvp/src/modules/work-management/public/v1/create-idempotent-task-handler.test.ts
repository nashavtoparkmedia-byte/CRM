import { describe, expect, it, vi } from 'vitest'
import {
    CREATE_IDEMPOTENT_TASK_COMMAND_V1,
    CREATE_IDEMPOTENT_TASK_RESULT_V1,
    ContractValidationError,
} from '@/contracts/work-management/v1'
import {
    createCreateIdempotentTaskHandlerV1,
    deterministicTaskIdV1,
    taskPayloadFingerprintV1,
} from './create-idempotent-task-handler'

const DATA = {
    driverId: 'driver-1',
    source: 'auto' as const,
    type: 'ai_call_followup',
    title: 'Call back',
}

describe('CreateIdempotentTaskCommand.v1', () => {
    it('validates the public command and returns the owner result contract', async () => {
        const createOrReplay = vi.fn().mockResolvedValue({
            status: 'created',
            task: { id: 'task-1', title: 'Call back' },
        })
        const handler = createCreateIdempotentTaskHandlerV1({ createOrReplay })

        await expect(handler({
            contract: CREATE_IDEMPOTENT_TASK_COMMAND_V1,
            idempotencyKey: 'ai-call-finalization-follow-up:v1:call-1',
            data: DATA,
        })).resolves.toEqual({
            contract: CREATE_IDEMPOTENT_TASK_RESULT_V1,
            status: 'created',
            task: { id: 'task-1', title: 'Call back' },
        })
        expect(createOrReplay).toHaveBeenCalledWith(expect.objectContaining({
            taskId: deterministicTaskIdV1('ai-call-finalization-follow-up:v1:call-1'),
            idempotencyKey: 'ai-call-finalization-follow-up:v1:call-1',
            payloadFingerprint: taskPayloadFingerprintV1(DATA),
            data: DATA,
        }))
    })

    it('keeps deterministic identity independent of time and normalizes default fields', () => {
        expect(deterministicTaskIdV1('same-key')).toBe(deterministicTaskIdV1('same-key'))
        expect(deterministicTaskIdV1('same-key')).not.toBe(deterministicTaskIdV1('other-key'))
        expect(taskPayloadFingerprintV1(DATA)).toBe(taskPayloadFingerprintV1({
            ...DATA,
            contactId: null,
            description: null,
            priority: 'medium',
            status: 'todo',
            assigneeId: null,
            createdBy: null,
            metadata: null,
        }))
        expect(taskPayloadFingerprintV1(DATA)).not.toBe(taskPayloadFingerprintV1({ ...DATA, title: 'Different' }))
    })

    it.each([
        { contract: 'work_management.CreateIdempotentTaskCommand.v2', idempotencyKey: 'key', data: DATA },
        { contract: CREATE_IDEMPOTENT_TASK_COMMAND_V1, idempotencyKey: '', data: DATA },
        { contract: CREATE_IDEMPOTENT_TASK_COMMAND_V1, idempotencyKey: 'key', data: { ...DATA, title: '' } },
        { contract: CREATE_IDEMPOTENT_TASK_COMMAND_V1, idempotencyKey: 'key', data: DATA, extra: true },
    ])('rejects malformed public commands', async (command) => {
        const handler = createCreateIdempotentTaskHandlerV1({ createOrReplay: vi.fn() })
        await expect(handler(command)).rejects.toBeInstanceOf(ContractValidationError)
    })
})
