import type { CreateTaskDataV1 } from '../../../../contracts/work-management/v1'

/** Pure mapping retained while Task persistence uses the monolith schema. */
export function mapCreateTaskDataToLegacyRecordV1(data: CreateTaskDataV1) {
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
        metadata: data.metadata ?? undefined,
    }
}
