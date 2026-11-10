'use client'

import { useState, useEffect } from 'react'
import { PageContainer } from '@/infrastructure/ui/PageContainer'
import { PageHeader } from '@/infrastructure/ui/PageHeader'
import { getUsers, addUser, updateUser, deleteUser, UserItem, getCurrentUser, getStaffCredentialStates, setStaffPassword, endStaffSessions } from '@/lib/users/user-service'
import { Plus, ToggleLeft, ToggleRight, User, Trash2, Mail, Phone, KeyRound } from 'lucide-react'

const ACTION_ERROR_TEXT: Record<string, string> = {
    forbidden: 'Недостаточно прав. Нужен вход Администратора по паролю',
    unavailable: 'Сейчас недоступно. Повторите позже',
    last_privileged_demotion: 'Нельзя убрать последнего Администратора или Руководителя',
    last_privileged_deletion: 'Нельзя удалить последнего Администратора или Руководителя',
    last_credentialed_administrator: 'Нельзя оставить систему без Администратора с паролем',
    password_too_short: 'Пароль слишком короткий (не меньше 10 символов)',
    password_too_long: 'Пароль слишком длинный',
    password_too_common: 'Слишком простой пароль',
    unknown_or_inactive_user: 'Сотрудник не найден или отключён',
    current_password_refused: 'Неверный текущий пароль',
    bootstrap_closed: 'Первый пароль уже задан. Пароли задаёт Администратор',
    busy: 'Сервер занят. Повторите через несколько секунд',
}

function errorText(code: string | undefined): string {
    return (code && ACTION_ERROR_TEXT[code]) || 'Действие не выполнено'
}

export default function UsersPage() {
    const [users, setUsers] = useState<UserItem[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [isAddOpen, setIsAddOpen] = useState(false)
    const [currentUser, setCurrentUser] = useState<any>(null)
    // Staff Session: who has a password. Null when this viewer may not see it.
    const [credentialStates, setCredentialStates] = useState<Record<string, 'live' | 'revoked'> | null>(null)
    const [passwordFor, setPasswordFor] = useState<string | null>(null)
    const [newPassword, setNewPassword] = useState('')
    const [notice, setNotice] = useState<string | null>(null)

    // Form states
    const [firstName, setFirstName] = useState('')
    const [lastName, setLastName] = useState('')
    const [email, setEmail] = useState('')
    const [phone, setPhone] = useState('')
    const [role, setRole] = useState<'Менеджер' | 'Руководитель' | 'Администратор'>('Менеджер')

    const load = () => {
        setIsLoading(true)
        getUsers().then(res => {
            setUsers(res)
            setIsLoading(false)
        })
        getStaffCredentialStates().then(setCredentialStates).catch(() => setCredentialStates(null))
    }

    const run = async (work: () => Promise<unknown>) => {
        setNotice(null)
        try {
            await work()
        } catch (error) {
            setNotice(errorText(error instanceof Error ? error.message : undefined))
        }
        load()
    }

    const handleSetPassword = async (id: string) => {
        const result = await setStaffPassword(id, newPassword)
        setNewPassword('')
        if (result.ok) {
            setPasswordFor(null)
            setNotice('Пароль сохранён. Прежние сеансы сотрудника завершены')
        } else {
            setNotice(errorText(result.reason))
        }
        load()
    }

    const handleEndSessions = async (id: string) => {
        const result = await endStaffSessions(id)
        setNotice(result === 'ended' ? 'Все сеансы сотрудника завершены' : errorText(result))
    }

    useEffect(() => {
        getCurrentUser().then(setCurrentUser)
        load()
    }, [])

    const handleAdd = async () => {
        if (!firstName.trim() || !lastName.trim()) return
        try {
            await addUser({ firstName, lastName, email, phone, role, status: 'Активен' })
        } catch (error) {
            setNotice(errorText(error instanceof Error ? error.message : undefined))
            return
        }
        setFirstName('')
        setLastName('')
        setEmail('')
        setPhone('')
        setIsAddOpen(false)
        load()
    }

    const handleToggleStatus = async (user: UserItem) => {
        await run(() => updateUser(user.id, { status: user.status === 'Активен' ? 'Отключен' : 'Активен' }))
    }

    const handleDelete = async (id: string) => {
        if (!confirm('Вы уверены, что хотите удалить пользователя?')) return
        await run(() => deleteUser(id))
    }

    const handleToggleRole = async (id: string, role: 'Менеджер' | 'Руководитель' | 'Администратор') => {
        await run(() => updateUser(id, { role }))
    }

    if (isLoading && users.length === 0) return <div className="p-[8px] text-center text-gray-500">Загрузка пользователей...</div>

    if (currentUser && currentUser.role === 'Менеджер') {
        return (
            <PageContainer>
                <div className="p-[8px] text-center text-red-500 font-bold bg-red-50 rounded-xl border border-red-200 mt-6 shadow-sm">
                    Доступ запрещен. Настройка пользователей разрешена только Администраторам и Руководителям.
                </div>
            </PageContainer>
        )
    }

    return (
        <PageContainer>
            <PageHeader 
                title="Пользователи" 
                description="Управление списком менеджеров и ролями" 
                action={
                    <button
                        onClick={() => setIsAddOpen(!isAddOpen)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-[#4f46e5] hover:bg-[#4338ca] text-white rounded-lg text-sm font-semibold transition-colors shadow-sm cursor-pointer"
                    >
                        <Plus size={16} />
                        Добавить менеджера
                    </button>
                }
            />

            {notice && (
                <div role="status" className="mt-[4px] px-3 py-2 rounded-lg border border-gray-200 bg-white text-[13px] text-gray-700 max-w-md">{notice}</div>
            )}

            {isAddOpen && (
                <div className="mt-[4px] bg-white p-[4px] rounded-xl border border-gray-200 shadow-sm space-y-3 max-w-md">
                    <h3 className="text-sm font-bold text-gray-900">Новый пользователь</h3>
                    <div className="grid grid-cols-2 gap-[2px]">
                        <input type="text" placeholder="Имя" value={firstName} onChange={e => setFirstName(e.target.value)} className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none" />
                        <input type="text" placeholder="Фамилия" value={lastName} onChange={e => setLastName(e.target.value)} className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none" />
                    </div>
                    <input type="email" placeholder="Email (необязательно)" value={email} onChange={e => setEmail(e.target.value)} className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none" />
                    <input type="text" placeholder="Телефон (необязательно)" value={phone} onChange={e => setPhone(e.target.value)} className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none" />
                    <select value={role} onChange={e => setRole(e.target.value as any)} className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none">
                        <option value="Менеджер">Менеджер</option>
                        <option value="Руководитель">Руководитель</option>
                        <option value="Администратор">Администратор</option>
                    </select>
                    <button onClick={handleAdd} className="w-full py-[2px] bg-[#4f46e5] hover:bg-[#4338ca] text-white font-semibold rounded-lg text-sm transition-colors cursor-pointer">Сохранить</button>
                </div>
            )}

            <div className="mt-6 bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                <div className="divide-y divide-gray-100">
                    {users.map((user) => (
                        <div key={user.id} className="flex flex-wrap items-center justify-between px-[4px] py-3 hover:bg-gray-50 transition-colors">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center font-bold text-gray-700 text-xs">
                                    {user.firstName[0]}{user.lastName[0]}
                                </div>
                                <div className="flex flex-col">
                                    <span className={`text-[14px] font-semibold ${user.status === 'Активен' ? 'text-gray-900' : 'text-gray-400 line-through'}`}>
                                        {user.firstName} {user.lastName}
                                    </span>
                                    <select 
                                        value={user.role} 
                                        onChange={(e) => handleToggleRole(user.id, e.target.value as any)} 
                                        className="text-[11px] text-gray-500 bg-transparent border-none outline-none cursor-pointer hover:underline cursor-pointer -ml-1 py-0 w-fit"
                                    >
                                        <option value="Менеджер">Менеджер</option>
                                        <option value="Руководитель">Руководитель</option>
                                        <option value="Администратор">Администратор</option>
                                    </select>
                                </div>
                            </div>
                            <div className="flex items-center gap-[4px]">
                                <div className="flex items-center gap-[2px] text-gray-400 text-[12px]">
                                    {user.email && <div className="flex items-center gap-1"><Mail size={12} /> {user.email}</div>}
                                    {user.phone && <div className="flex items-center gap-1"><Phone size={12} /> {user.phone}</div>}
                                </div>
                                {credentialStates && (
                                    <button
                                        onClick={() => { setPasswordFor(passwordFor === user.id ? null : user.id); setNewPassword('') }}
                                        className="flex items-center gap-1 p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 text-[12px] cursor-pointer"
                                        title="Пароль для входа"
                                    >
                                        <KeyRound size={16} />
                                        {credentialStates[user.id] === 'live' ? 'пароль задан' : credentialStates[user.id] === 'revoked' ? 'вход закрыт' : 'нет пароля'}
                                    </button>
                                )}
                                <button
                                    onClick={() => handleToggleStatus(user)}
                                    className={`p-1.5 rounded-lg transition-colors ${user.status === 'Активен' ? 'text-green-600 hover:bg-green-50' : 'text-gray-400 hover:bg-gray-100'}`}
                                    title={user.status === 'Активен' ? 'Отключить' : 'Активировать'}
                                >
                                    {user.status === 'Активен' ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
                                </button>
                                <button
                                    onClick={() => handleDelete(user.id)}
                                    className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 transition-colors cursor-pointer"
                                    title="Удалить"
                                >
                                    <Trash2 size={20} />
                                </button>
                            </div>
                            {passwordFor === user.id && (
                                <div className="w-full mt-2 flex items-center gap-[4px]">
                                    <input
                                        type="password"
                                        autoComplete="new-password"
                                        placeholder="Новый пароль (не меньше 10 символов)"
                                        value={newPassword}
                                        onChange={e => setNewPassword(e.target.value)}
                                        className="flex-1 h-11 px-3 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary"
                                    />
                                    <button onClick={() => handleSetPassword(user.id)} disabled={newPassword.length === 0} className="h-11 px-4 rounded-lg bg-primary text-white text-sm font-semibold disabled:opacity-50 cursor-pointer">Сохранить</button>
                                    {credentialStates?.[user.id] === 'live' && (
                                        <button onClick={() => handleEndSessions(user.id)} className="h-11 px-4 rounded-lg border border-gray-200 text-sm text-gray-700 cursor-pointer">Завершить сеансы</button>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        </PageContainer>
    )
}
