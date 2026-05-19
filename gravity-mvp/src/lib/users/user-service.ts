'use server'

import fs from 'fs/promises'
import path from 'path'
import { cookies } from 'next/headers'
// Pure user-resolution helper. Lives in a sibling `.js` so the
// unit-test can require it directly via `node --test`, without a
// TypeScript loader. See `./auth-helpers.js`.
import { pickUserById } from './auth-helpers'

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
    const id = cookieStore.get('crm_user_id')?.value

    // Intentionally no fallback user.
    // Anonymous requests must fail closed — every caller is responsible
    // for an explicit `if (!user) return 401` guard. The previous
    // `if (!id) id = 'u3'` fallback let any anonymous request inherit
    // `Руководитель` privileges (see `.claude/knowledge/security_debt.md`).
    //
    // Temporary instrumentation: warn once per call so unexpected
    // anonymous traffic surfaces in dev-server logs after deploy. Drop
    // this log once the next-step `login(userId)` redesign lands and we
    // confirm the auth surface is fully tightened.
    if (!id) {
        console.warn('[auth] anonymous request (no crm_user_id cookie)')
        return null
    }

    const users = await getUsers()
    return (pickUserById(users, id) as UserItem | null)
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
