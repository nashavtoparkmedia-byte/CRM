'use server'

import fs from 'fs/promises'
import path from 'path'

const filePath = path.join(process.cwd(), 'src/data/dictionaries.json')

export interface DictionaryItem {
    id: string
    label: string
    isActive: boolean
    metadata?: Record<string, any>
}

export type DictionaryType = 'scenarios' | 'events' | 'statuses' | 'priorities' | 'sources' | 'history_actions' | 'contact_results' | 'next_actions'

export type Dictionaries = Record<DictionaryType, DictionaryItem[]>

export async function getDictionaries(): Promise<Dictionaries> {
    try {
        const data = await fs.readFile(filePath, 'utf-8')
        return JSON.parse(data) as Dictionaries
    } catch (error) {
        console.error('Failed to read dictionaries:', error)
        return {} as Dictionaries
    }
}

export async function addDictionaryItem(type: DictionaryType, item: Omit<DictionaryItem, 'id'>): Promise<DictionaryItem> {
    const dicts = await getDictionaries()
    const id = Math.random().toString(36).substring(2, 9)
    const newItem = { ...item, id }
    dicts[type].push(newItem)
    await fs.writeFile(filePath, JSON.stringify(dicts, null, 2))
    return newItem
}

export async function updateDictionaryItem(type: DictionaryType, id: string, patch: Partial<Omit<DictionaryItem, 'id'>>): Promise<void> {
    const dicts = await getDictionaries()
    const list = dicts[type]
    const idx = list.findIndex(i => i.id === id)
    if (idx !== -1) {
        list[idx] = { ...list[idx], ...patch }
        await fs.writeFile(filePath, JSON.stringify(dicts, null, 2))
    }
}

export async function deleteDictionaryItem(type: DictionaryType, id: string): Promise<void> {
    const dicts = await getDictionaries()
    dicts[type] = dicts[type].filter(i => i.id !== id)
    await fs.writeFile(filePath, JSON.stringify(dicts, null, 2))
}
