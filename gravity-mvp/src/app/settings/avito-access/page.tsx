'use client'

/**
 * /settings/avito-access — управление доступом к встроенному сервису
 * Avito (standalone). Multi-user: список пользователей + добавление,
 * сброс пароля, выключение, удаление.
 *
 * Все запросы идут через CRM proxy /avito-app/api/* — middleware
 * подкладывает X-Auth-User=<crm_user_id>, Avito пишет это в
 * updated_by для аудита.
 *
 * Менеджерам внутри CRM эти учётки не нужны (вход бесшовный по
 * сессии CRM). Эти логины — для прямого доступа к standalone Avito
 * (например http://localhost:3000) когда Avito хочется использовать
 * без CRM-обёртки.
 */

import { useEffect, useState } from 'react'
import {
    Megaphone,
    RefreshCw,
    Copy,
    UserPlus,
    Power,
    Trash2,
    KeyRound,
    AlertTriangle,
} from 'lucide-react'

type AvitoUser = {
    id: number
    username: string
    updatedAt: string
    updatedBy: string | null
    disabled: boolean
}

const AVITO_API = '/avito-app/api'

async function fetchUsers(): Promise<{ users: AvitoUser[]; mode: string }> {
    const res = await fetch(`${AVITO_API}/auth/admin/users`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
}

async function postJSON<T>(path: string, body: any, method = 'POST'): Promise<T> {
    const res = await fetch(`${AVITO_API}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try { msg = (await res.json())?.message ?? msg } catch {}
        throw new Error(msg)
    }
    return res.json()
}

function fmt(iso: string): string {
    return new Date(iso).toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

export default function AvitoAccessPage() {
    const [users, setUsers] = useState<AvitoUser[]>([])
    const [mode, setMode] = useState<string>('builtin')
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [showAdd, setShowAdd] = useState(false)
    const [revealed, setRevealed] = useState<{
        username: string
        password: string
        action: 'created' | 'reset'
        copied: boolean
    } | null>(null)
    const [busy, setBusy] = useState<number | 'add' | null>(null)

    const load = async () => {
        setLoading(true)
        setError(null)
        try {
            const r = await fetchUsers()
            setUsers(r.users)
            setMode(r.mode)
        } catch (e: any) {
            setError(e?.message ?? String(e))
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => { void load() }, [])

    async function copy(text: string) {
        try {
            await navigator.clipboard.writeText(text)
            if (revealed) setRevealed({ ...revealed, copied: true })
        } catch {}
    }

    async function doReset(user: AvitoUser) {
        const customRaw = prompt(
            `Сбросить пароль для "${user.username}".\n\n` +
                'Введи новый пароль (минимум 8 символов) или ОК с пустым полем — будет сгенерирован случайный 16-символьный.\n\n' +
                'Все активные сессии Avito будут разлогинены.',
            '',
        )
        if (customRaw === null) return
        setBusy(user.id)
        setError(null)
        try {
            const r = await postJSON<{
                username: string
                password: string
                mode: 'random' | 'custom'
            }>(`/auth/admin/users/${user.id}/reset-password`, {
                password: customRaw.trim() || undefined,
            })
            setRevealed({ ...r, action: 'reset', copied: false })
            await load()
        } catch (e: any) {
            setError(e?.message ?? String(e))
        } finally {
            setBusy(null)
        }
    }

    async function doToggle(user: AvitoUser) {
        const next = !user.disabled
        const ok = confirm(
            next
                ? `Выключить пользователя "${user.username}"? Он не сможет залогиниться, но запись сохранится.`
                : `Включить пользователя "${user.username}"?`,
        )
        if (!ok) return
        setBusy(user.id)
        setError(null)
        try {
            await postJSON(`/auth/admin/users/${user.id}`, { disabled: next }, 'PATCH')
            await load()
        } catch (e: any) {
            setError(e?.message ?? String(e))
        } finally {
            setBusy(null)
        }
    }

    async function doDelete(user: AvitoUser) {
        if (
            !confirm(
                `Удалить пользователя "${user.username}" БЕЗ возможности восстановить?\n\n` +
                    'Если хочешь временно отключить — используй кнопку выключения.',
            )
        )
            return
        setBusy(user.id)
        setError(null)
        try {
            await postJSON(`/auth/admin/users/${user.id}`, undefined, 'DELETE')
            await load()
        } catch (e: any) {
            setError(e?.message ?? String(e))
        } finally {
            setBusy(null)
        }
    }

    return (
        <div className="p-6 max-w-5xl">
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <Megaphone className="w-7 h-7 text-[#4f46e5]" />
                    <div>
                        <h1 className="text-2xl font-semibold text-gray-900">
                            Доступ к Avito (standalone)
                        </h1>
                        <p className="text-sm text-gray-500 mt-0.5">
                            Логины для прямого входа в сервис Avito (отдельно
                            от CRM). Менеджерам внутри CRM эти логины не нужны —
                            вход бесшовный.
                        </p>
                    </div>
                </div>
                <button
                    onClick={() => { setShowAdd(true); setRevealed(null) }}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-[#4f46e5] hover:bg-[#4338ca] text-white text-sm font-medium"
                >
                    <UserPlus className="w-4 h-4" />
                    Добавить пользователя
                </button>
            </div>

            {error && (
                <div className="bg-red-50 border border-red-200 text-red-800 rounded-md p-4 mb-4 text-sm">
                    <strong>Ошибка:</strong> {error}
                </div>
            )}

            {revealed && (
                <div className="bg-green-50 border border-green-300 rounded-md p-5 mb-4">
                    <div className="text-sm text-green-900 font-medium mb-3">
                        ✓ Пользователь {revealed.action === 'created' ? 'создан' : 'сменил пароль'}.
                        Покажется только один раз — сохрани!
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm mb-3">
                        <div className="text-green-800">Логин</div>
                        <div className="font-mono font-bold text-green-950 flex items-center gap-2">
                            {revealed.username}
                            <button
                                onClick={() => void copy(revealed.username)}
                                className="text-green-700 hover:text-green-900"
                                title="Скопировать логин"
                            >
                                <Copy className="w-3.5 h-3.5" />
                            </button>
                        </div>
                        <div className="text-green-800">Пароль</div>
                        <div className="font-mono font-bold text-green-950 flex items-center gap-2 break-all">
                            {revealed.password}
                            <button
                                onClick={() => void copy(revealed.password)}
                                className="text-green-700 hover:text-green-900 shrink-0"
                                title="Скопировать пароль"
                            >
                                <Copy className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    </div>
                    {revealed.copied && (
                        <div className="text-xs text-green-700">✓ Скопировано в буфер</div>
                    )}
                </div>
            )}

            {mode === 'upstream' && (
                <div className="bg-blue-50 border border-blue-200 text-blue-900 rounded-md p-3 mb-4 text-xs flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <div>
                        Avito сейчас в режиме <code>upstream</code> — внутри CRM
                        вход бесшовный (по сессии CRM), эти логины используются
                        ТОЛЬКО для прямого захода на standalone Avito (например{' '}
                        <a href="http://localhost:3000" target="_blank" rel="noreferrer" className="underline font-mono">http://localhost:3000</a>).
                    </div>
                </div>
            )}

            {loading ? (
                <div className="text-gray-500 text-sm">Загрузка…</div>
            ) : users.length === 0 ? (
                <div className="bg-white border border-gray-200 rounded-md p-12 text-center text-sm text-gray-500">
                    Пользователей пока нет. Жми «Добавить пользователя».
                </div>
            ) : (
                <div className="bg-white border border-gray-200 rounded-md overflow-hidden">
                    <table className="w-full text-sm">
                        <thead className="bg-gray-50 border-b border-gray-200">
                            <tr className="text-left text-xs uppercase tracking-wider text-gray-500">
                                <th className="px-4 py-3 font-medium">Логин</th>
                                <th className="px-4 py-3 font-medium">Изменён</th>
                                <th className="px-4 py-3 font-medium">Кем (CRM)</th>
                                <th className="px-4 py-3 font-medium">Статус</th>
                                <th className="px-4 py-3 font-medium text-right">Действия</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {users.map((u) => (
                                <tr key={u.id} className={u.disabled ? 'opacity-60' : ''}>
                                    <td className="px-4 py-3 font-mono font-medium text-gray-900">{u.username}</td>
                                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{fmt(u.updatedAt)}</td>
                                    <td className="px-4 py-3 text-gray-600">{u.updatedBy ?? '—'}</td>
                                    <td className="px-4 py-3">
                                        {u.disabled ? (
                                            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                                                выключен
                                            </span>
                                        ) : (
                                            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700">
                                                активен
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3">
                                        <div className="flex items-center justify-end gap-1">
                                            <button
                                                onClick={() => void doReset(u)}
                                                disabled={busy === u.id}
                                                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-gray-200 hover:bg-gray-50 text-gray-700 disabled:opacity-50"
                                                title="Сменить пароль"
                                            >
                                                <KeyRound className="w-3.5 h-3.5" />
                                                Пароль
                                            </button>
                                            <button
                                                onClick={() => void doToggle(u)}
                                                disabled={busy === u.id}
                                                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-gray-200 hover:bg-gray-50 text-gray-700 disabled:opacity-50"
                                                title={u.disabled ? 'Включить' : 'Выключить'}
                                            >
                                                <Power className="w-3.5 h-3.5" />
                                                {u.disabled ? 'Включить' : 'Выключить'}
                                            </button>
                                            <button
                                                onClick={() => void doDelete(u)}
                                                disabled={busy === u.id}
                                                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-red-200 hover:bg-red-50 text-red-700 disabled:opacity-50"
                                                title="Удалить безвозвратно"
                                            >
                                                <Trash2 className="w-3.5 h-3.5" />
                                                Удалить
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {showAdd && (
                <AddUserModal
                    onClose={() => setShowAdd(false)}
                    onCreated={(u) => {
                        setRevealed({ ...u, action: 'created', copied: false })
                        setShowAdd(false)
                        void load()
                    }}
                    onError={(msg) => setError(msg)}
                />
            )}
        </div>
    )
}

function AddUserModal({
    onClose,
    onCreated,
    onError,
}: {
    onClose: () => void
    onCreated: (u: { username: string; password: string }) => void
    onError: (msg: string) => void
}) {
    const [username, setUsername] = useState('')
    const [password, setPassword] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const usernameValid = /^[a-zA-Z0-9._-]{2,}$/.test(username)
    const passwordValid = password.length === 0 || password.length >= 8

    async function submit(useRandom: boolean) {
        if (!usernameValid) return
        if (!useRandom && !passwordValid) return
        setSubmitting(true)
        try {
            const r = await postJSON<{
                id: number
                username: string
                password: string
            }>('/auth/admin/users', {
                username,
                password: useRandom ? undefined : password,
            })
            onCreated(r)
        } catch (e: any) {
            onError(e?.message ?? String(e))
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
            onClick={onClose}
        >
            <div
                className="bg-white rounded-md p-6 w-full max-w-md shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <h3 className="text-lg font-semibold mb-4">Добавить пользователя Avito</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm text-gray-700 mb-1">Логин</label>
                        <input
                            type="text"
                            placeholder="ivan_petrov"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            disabled={submitting}
                            autoFocus
                            className="w-full px-3 py-2 text-sm font-mono rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-[#4f46e5]"
                        />
                        <div className="text-xs text-gray-500 mt-1">
                            Латиница, цифры, точка/тире/подчёркивание. Минимум 2 символа.
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm text-gray-700 mb-1">
                            Пароль
                        </label>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                placeholder="введи свой или жми «Сгенерировать»"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                disabled={submitting}
                                className="flex-1 px-3 py-2 text-sm font-mono rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-[#4f46e5]"
                            />
                            <button
                                type="button"
                                onClick={() => {
                                    // Браузерный crypto — генерим 16-символьный
                                    // base64-без-спецсимволов прямо в поле, чтобы
                                    // оператор увидел и мог скопировать.
                                    const bytes = new Uint8Array(12)
                                    crypto.getRandomValues(bytes)
                                    const hex = btoa(String.fromCharCode(...bytes))
                                        .replace(/[+/=]/g, '')
                                        .slice(0, 16)
                                    setPassword(hex)
                                }}
                                disabled={submitting}
                                className="inline-flex items-center gap-1 px-3 py-2 rounded-md border border-gray-300 hover:bg-gray-50 text-gray-700 text-sm whitespace-nowrap"
                                title="Сгенерировать случайный пароль и подставить в поле"
                            >
                                <RefreshCw className="w-3.5 h-3.5" />
                                Сгенерировать
                            </button>
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                            {password.length === 0
                                ? 'Введи свой пароль или нажми «Сгенерировать».'
                                : password.length < 8
                                  ? `Слишком короткий (${password.length}/8 минимум)`
                                  : `✓ ${password.length} символов`}
                        </div>
                    </div>
                </div>

                <div className="flex items-center justify-between gap-2 mt-6">
                    <button
                        onClick={onClose}
                        disabled={submitting}
                        className="px-4 py-2 text-sm rounded-md border border-gray-300 hover:bg-gray-50 text-gray-700"
                    >
                        Отмена
                    </button>
                    <button
                        onClick={() => void submit(false)}
                        disabled={
                            submitting ||
                            !usernameValid ||
                            password.length < 8
                        }
                        className="px-5 py-2 rounded-md bg-[#4f46e5] hover:bg-[#4338ca] text-white text-sm font-medium disabled:opacity-50"
                    >
                        Создать
                    </button>
                </div>
            </div>
        </div>
    )
}
