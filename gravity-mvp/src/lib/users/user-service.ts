'use server'

import fs from 'fs/promises'
import path from 'path'
import { cookies } from 'next/headers'

const filePath = path.join(process.cwd(), 'src/data/users.json')

export interface UserItem {
    id: string
    firstName: string
    lastName: string
    email?: string
    phone?: string
    role: 'Менеджер' | 'Руководитель' | 'Администратор'
    status: 'Активен' | 'Отключен'
    createdAt: string
}

export async function getUsers(): Promise<UserItem[]> {
    try {
        const data = await fs.readFile(filePath, 'utf-8')
        return JSON.parse(data) as UserItem[]
    } catch { return [] }
}

export async function getCurrentUser(): Promise<UserItem | null> {
    const cookieStore = await cookies()
    let id = cookieStore.get('crm_user_id')?.value
    if (!id) id = 'u3' // Force fallback login for Supervisor
    const users = await getUsers()
    return users.find(u => u.id === id) || null
}

export async function login(userId: string) {
    const cookieStore = await cookies()
    cookieStore.set('crm_user_id', userId, { maxAge: 60 * 60 * 24 * 7 }) // 1 week
}

export async function logout() {
    const cookieStore = await cookies()
    cookieStore.delete('crm_user_id')
}

export async function addUser(item: Omit<UserItem, 'id' | 'createdAt'>): Promise<UserItem> {
    const users = await getUsers()
    const id = "u" + (users.length + 1)
    const newItem = { ...item, id, createdAt: new Date().toISOString() }
    users.push(newItem)
    await fs.writeFile(filePath, JSON.stringify(users, null, 2))
    return newItem
}

export async function updateUser(id: string, patch: Partial<Omit<UserItem, 'id'>>): Promise<void> {
    const users = await getUsers()
    const idx = users.findIndex(u => u.id === id)
    if (idx !== -1) {
        users[idx] = { ...users[idx], ...patch }
        await fs.writeFile(filePath, JSON.stringify(users, null, 2))
    }
}

export async function deleteUser(id: string): Promise<void> {
    const users = await getUsers()
    const filtered = users.filter(u => u.id !== id)
    const filePath = path.join(process.cwd(), 'src/data/users.json')
    await fs.writeFile(filePath, JSON.stringify(filtered, null, 2))
}
