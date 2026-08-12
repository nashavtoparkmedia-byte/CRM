import fs from 'fs/promises'
import path from 'path'
import type {
    TaskDictionariesV1,
    TaskDictionaryItemV1,
    TaskDictionaryTypeV1,
} from '../../../contracts/work-management/v1'

const filePath = path.join(process.cwd(), 'src/data/dictionaries.json')

export async function getTaskDictionaries(): Promise<TaskDictionariesV1> {
    try {
        const data = await fs.readFile(filePath, 'utf-8')
        return JSON.parse(data) as TaskDictionariesV1
    } catch (error) {
        console.error('Failed to read dictionaries:', error)
        return {} as TaskDictionariesV1
    }
}

export async function addTaskDictionaryItem(
    type: TaskDictionaryTypeV1,
    item: Omit<TaskDictionaryItemV1, 'id'>,
): Promise<TaskDictionaryItemV1> {
    const dicts = await getTaskDictionaries()
    const id = Math.random().toString(36).substring(2, 9)
    const newItem = { ...item, id }
    dicts[type].push(newItem)
    await fs.writeFile(filePath, JSON.stringify(dicts, null, 2))
    return newItem
}

export async function updateTaskDictionaryItem(
    type: TaskDictionaryTypeV1,
    id: string,
    patch: Partial<Omit<TaskDictionaryItemV1, 'id'>>,
): Promise<void> {
    const dicts = await getTaskDictionaries()
    const list = dicts[type]
    const idx = list.findIndex((item) => item.id === id)
    if (idx !== -1) {
        list[idx] = { ...list[idx], ...patch }
        await fs.writeFile(filePath, JSON.stringify(dicts, null, 2))
    }
}

export async function deleteTaskDictionaryItem(
    type: TaskDictionaryTypeV1,
    id: string,
): Promise<void> {
    const dicts = await getTaskDictionaries()
    dicts[type] = dicts[type].filter((item) => item.id !== id)
    await fs.writeFile(filePath, JSON.stringify(dicts, null, 2))
}
