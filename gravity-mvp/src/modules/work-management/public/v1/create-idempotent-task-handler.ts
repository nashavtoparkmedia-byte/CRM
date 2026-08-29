import { createHash } from 'node:crypto'
import {
    CREATE_IDEMPOTENT_TASK_RESULT_V1,
    parseCreateIdempotentTaskCommandV1,
    type CreateIdempotentTaskCommandV1,
    type CreateIdempotentTaskResultV1,
    type CreateTaskDataV1,
    type JsonValueV1,
} from '../../../../contracts/work-management/v1'

export interface IdempotentTaskCreateRequestV1 {
    taskId: string
    idempotencyKey: string
    payloadFingerprint: string
    data: CreateTaskDataV1
}

export interface IdempotentTaskPersistencePortV1 {
    createOrReplay(request: IdempotentTaskCreateRequestV1): Promise<{
        status: 'created' | 'replayed'
        task: { id: string; title: string }
    }>
}

function canonicalJson(value: JsonValueV1): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function normalizedTaskData(data: CreateTaskDataV1): { [key: string]: JsonValueV1 } {
    return {
        driverId: data.driverId ?? null,
        contactId: data.contactId ?? null,
        source: data.source,
        type: data.type,
        title: data.title,
        description: data.description ?? null,
        priority: data.priority ?? 'medium',
        status: data.status ?? 'todo',
        assigneeId: data.assigneeId ?? null,
        createdBy: data.createdBy ?? null,
        metadata: data.metadata ?? null,
    }
}

export function deterministicTaskIdV1(idempotencyKey: string): string {
    return `task_idem_${createHash('sha256').update(idempotencyKey).digest('hex')}`
}

export function taskPayloadFingerprintV1(data: CreateTaskDataV1): string {
    return createHash('sha256').update(canonicalJson(normalizedTaskData(data))).digest('hex')
}

export function createCreateIdempotentTaskHandlerV1(port: IdempotentTaskPersistencePortV1) {
    return async function createIdempotentTaskV1(
        command: CreateIdempotentTaskCommandV1 | unknown,
    ): Promise<CreateIdempotentTaskResultV1> {
        const parsed = parseCreateIdempotentTaskCommandV1(command)
        const result = await port.createOrReplay({
            taskId: deterministicTaskIdV1(parsed.idempotencyKey),
            idempotencyKey: parsed.idempotencyKey,
            payloadFingerprint: taskPayloadFingerprintV1(parsed.data),
            data: parsed.data,
        })

        return {
            contract: CREATE_IDEMPOTENT_TASK_RESULT_V1,
            status: result.status,
            task: result.task,
        }
    }
}
