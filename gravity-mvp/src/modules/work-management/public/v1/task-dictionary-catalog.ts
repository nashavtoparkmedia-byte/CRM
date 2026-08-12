'use server'

import type {
    TaskDictionariesV1,
    TaskDictionaryItemV1,
    TaskDictionaryTypeV1,
} from '../../../../contracts/work-management/v1'
import {
    addTaskDictionaryItem,
    deleteTaskDictionaryItem,
    getTaskDictionaries,
    updateTaskDictionaryItem,
} from '../../internal/task-dictionary-store'

export async function getTaskDictionariesV1(): Promise<TaskDictionariesV1> {
    return getTaskDictionaries()
}

export async function addTaskDictionaryItemV1(
    type: TaskDictionaryTypeV1,
    item: Omit<TaskDictionaryItemV1, 'id'>,
): Promise<TaskDictionaryItemV1> {
    return addTaskDictionaryItem(type, item)
}

export async function updateTaskDictionaryItemV1(
    type: TaskDictionaryTypeV1,
    id: string,
    patch: Partial<Omit<TaskDictionaryItemV1, 'id'>>,
): Promise<void> {
    return updateTaskDictionaryItem(type, id, patch)
}

export async function deleteTaskDictionaryItemV1(
    type: TaskDictionaryTypeV1,
    id: string,
): Promise<void> {
    return deleteTaskDictionaryItem(type, id)
}
