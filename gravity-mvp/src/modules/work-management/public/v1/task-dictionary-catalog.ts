'use server'

import type {
    TaskDictionariesV1,
    TaskDictionaryItemV1,
    TaskDictionaryTypeV1,
} from '../../../../contracts/work-management/v1'
import {
    addTaskDictionaryItemOperation,
    deleteTaskDictionaryItemOperation,
    getTaskDictionariesOperation,
    updateTaskDictionaryItemOperation,
} from '../../application/task-dictionary-operations'

export async function getTaskDictionariesV1(): Promise<TaskDictionariesV1> {
    return getTaskDictionariesOperation()
}

export async function addTaskDictionaryItemV1(
    type: TaskDictionaryTypeV1,
    item: Omit<TaskDictionaryItemV1, 'id'>,
): Promise<TaskDictionaryItemV1> {
    return addTaskDictionaryItemOperation(type, item)
}

export async function updateTaskDictionaryItemV1(
    type: TaskDictionaryTypeV1,
    id: string,
    patch: Partial<Omit<TaskDictionaryItemV1, 'id'>>,
): Promise<void> {
    return updateTaskDictionaryItemOperation(type, id, patch)
}

export async function deleteTaskDictionaryItemV1(
    type: TaskDictionaryTypeV1,
    id: string,
): Promise<void> {
    return deleteTaskDictionaryItemOperation(type, id)
}
