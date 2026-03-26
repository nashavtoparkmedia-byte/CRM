'use client'

import { useState, useEffect } from 'react'
import { PageContainer } from '@/components/ui/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { getUsers, addUser, updateUser, deleteUser, UserItem, getCurrentUser } from '@/lib/users/user-service'
import { Plus, ToggleLeft, ToggleRight, User, Trash2, Mail, Phone } from 'lucide-react'

export default function UsersPage() {
    const [users, setUsers] = useState<UserItem[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [isAddOpen, setIsAddOpen] = useState(false)
    const [currentUser, setCurrentUser] = useState<any>(null)

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
    }

    useEffect(() => {
        getCurrentUser().then(setCurrentUser)
        load()
    }, [])

    const handleAdd = async () => {
        if (!firstName.trim() || !lastName.trim()) return
        await addUser({ firstName, lastName, email, phone, role, status: 'Активен' })
        setFirstName('')
        setLastName('')
        setEmail('')
        setPhone('')
        setIsAddOpen(false)
        load()
    }

    const handleToggleStatus = async (user: UserItem) => {
        await updateUser(user.id, { status: user.status === 'Активен' ? 'Отключен' : 'Активен' })
        load()
    }

    const handleDelete = async (id: string) => {
        if (!confirm('Вы уверены, что хотите удалить пользователя?')) return
        await deleteUser(id)
        load()
    }

    const handleToggleRole = async (id: string, role: 'Менеджер' | 'Руководитель' | 'Администратор') => {
        await updateUser(id, { role })
        load()
    }

    if (isLoading && users.length === 0) return <div className="p-8 text-center text-gray-500">Загрузка пользователей...</div>

    if (currentUser && currentUser.role === 'Менеджер') {
        return (
            <PageContainer>
                <div className="p-8 text-center text-red-500 font-bold bg-red-50 rounded-xl border border-red-200 mt-6 shadow-sm">
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

            {isAddOpen && (
                <div className="mt-4 bg-white p-4 rounded-xl border border-gray-200 shadow-sm space-y-3 max-w-md">
                    <h3 className="text-sm font-bold text-gray-900">Новый пользователь</h3>
                    <div className="grid grid-cols-2 gap-2">
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
                    <button onClick={handleAdd} className="w-full py-2 bg-[#4f46e5] hover:bg-[#4338ca] text-white font-semibold rounded-lg text-sm transition-colors cursor-pointer">Сохранить</button>
                </div>
            )}

            <div className="mt-6 bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                <div className="divide-y divide-gray-100">
                    {users.map((user) => (
                        <div key={user.id} className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors">
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
                            <div className="flex items-center gap-4">
                                <div className="flex items-center gap-2 text-gray-400 text-[12px]">
                                    {user.email && <div className="flex items-center gap-1"><Mail size={12} /> {user.email}</div>}
                                    {user.phone && <div className="flex items-center gap-1"><Phone size={12} /> {user.phone}</div>}
                                </div>
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
                        </div>
                    ))}
                </div>
            </div>
        </PageContainer>
    )
}
