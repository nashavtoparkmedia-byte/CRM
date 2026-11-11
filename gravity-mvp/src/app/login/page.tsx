'use client'

import { useState, useEffect } from 'react'
import { getLoginMode, getSignInEmployees, login, staffLogin } from '@/lib/users/user-service'
import { LogIn } from 'lucide-react'

type LoginMode = 'password' | 'legacy' | 'unavailable' | 'loading'

const FAILURE_TEXT: Record<string, string> = {
    refused: 'Неверный пароль',
    throttled: 'Слишком много попыток. Попробуйте позже',
    busy: 'Сервер занят. Повторите через несколько секунд',
    unavailable: 'Вход временно недоступен',
    session_active: 'Сначала выйдите из мобильной сессии',
}

export default function LoginPage() {
    const [users, setUsers] = useState<any[]>([])
    const [mode, setMode] = useState<LoginMode>('loading')
    const [selected, setSelected] = useState<any | null>(null)
    const [password, setPassword] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [pending, setPending] = useState(false)

    useEffect(() => {
        getSignInEmployees().then(setUsers)
        getLoginMode().then(setMode)
    }, [])

    const handleChoose = async (user: any) => {
        setError(null)
        if (mode === 'password') {
            setSelected(user)
            setPassword('')
            return
        }
        try {
            await login(user.id)
            window.location.href = '/'
        } catch {
            setError('Вход для этой учётной записи — только по паролю')
        }
    }

    const handlePassword = async (event: React.FormEvent) => {
        event.preventDefault()
        if (!selected || pending) return
        setPending(true)
        setError(null)
        const result = await staffLogin(selected.id, password)
        setPending(false)
        setPassword('')
        if (result.ok) {
            window.location.href = '/'
            return
        }
        setError(FAILURE_TEXT[result.reason] ?? FAILURE_TEXT.unavailable)
    }

    return (
        <div className="flex flex-col items-center justify-center h-screen bg-gray-50 p-6">
            <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-xl w-full max-w-sm text-center">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary mx-auto mb-[4px]">
                    <LogIn size={24} />
                </div>
                <h1 className="text-xl font-bold text-gray-900 mb-1">CRM Вход</h1>

                {selected ? (
                    <form onSubmit={handlePassword} className="text-left">
                        <p className="text-xs text-gray-500 mb-5 text-center">
                            {selected.firstName} {selected.lastName}
                        </p>
                        <label htmlFor="staff-password" className="block text-[13px] font-medium text-gray-700 mb-1">Пароль</label>
                        <input
                            id="staff-password"
                            type="password"
                            autoComplete="current-password"
                            autoFocus
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            className="w-full h-11 px-3 border border-gray-200 rounded-lg text-[15px] focus:outline-none focus:border-primary"
                        />
                        {error && <p role="alert" className="text-[13px] text-red-600 mt-2">{error}</p>}
                        <button
                            type="submit"
                            disabled={pending || password.length === 0}
                            className="w-full h-11 mt-4 rounded-lg bg-primary text-white text-[15px] font-semibold disabled:opacity-50"
                        >
                            {pending ? 'Вход…' : 'Войти'}
                        </button>
                        <button
                            type="button"
                            onClick={() => { setSelected(null); setError(null); setPassword('') }}
                            className="w-full h-11 mt-2 rounded-lg border border-gray-200 text-[15px] text-gray-700"
                        >
                            Другой сотрудник
                        </button>
                    </form>
                ) : (
                    <>
                        <p className="text-xs text-gray-500 mb-5">
                            {mode === 'unavailable' ? 'Вход временно недоступен' : 'Выберите учетную запись для работы'}
                        </p>
                        {error && <p role="alert" className="text-[13px] text-red-600 mb-3">{error}</p>}
                        <div className="space-y-[2px]">
                            {mode !== 'unavailable' && users.map(u => (
                                <button
                                    key={u.id}
                                    disabled={mode === 'loading'}
                                    onClick={() => handleChoose(u)}
                                    className="w-full text-left px-[4px] py-3 border border-gray-100 hover:border-primary/30 hover:bg-primary/5 rounded-xl transition-all flex items-center justify-between group cursor-pointer"
                                >
                                    <div>
                                        <div className="text-[14px] font-semibold text-gray-900 group-hover:text-primary transition-colors">
                                            {u.firstName} {u.lastName}
                                        </div>
                                        <div className="text-[11px] text-gray-400">{u.role}</div>
                                    </div>
                                    <div className="w-6 h-6 rounded-full bg-gray-50 flex items-center justify-center text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity">
                                        →
                                    </div>
                                </button>
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    )
}
