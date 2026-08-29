// Application composition exposes business operations, never persistence handles.
import type {
    TaskDictionariesV1,
    TaskDictionaryItemV1,
    TaskDictionaryTypeV1,
} from '../../../contracts/work-management/v1'
import {
    addTaskDictionaryItem,
    deleteTaskDictionaryItem,
    getTaskDictionaries,
    updateTaskDictionaryItem,
} from '../internal/task-dictionary-store'

export const getTaskDictionariesOperation = (): Promise<TaskDictionariesV1> => getTaskDictionaries()

export const addTaskDictionaryItemOperation = (
    type: TaskDictionaryTypeV1,
    item: Omit<TaskDictionaryItemV1, 'id'>,
): Promise<TaskDictionaryItemV1> => addTaskDictionaryItem(type, item)

export const updateTaskDictionaryItemOperation = (
    type: TaskDictionaryTypeV1,
    id: string,
    patch: Partial<Omit<TaskDictionaryItemV1, 'id'>>,
): Promise<void> => updateTaskDictionaryItem(type, id, patch)

export const deleteTaskDictionaryItemOperation = (
    type: TaskDictionaryTypeV1,
    id: string,
): Promise<void> => deleteTaskDictionaryItem(type, id)
