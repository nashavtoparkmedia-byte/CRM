'use client'

import { useState, useEffect } from 'react'
import { getUsers, login } from '@/lib/users/user-service'
import { LogIn } from 'lucide-react'

export default function LoginPage() {
    const [users, setUsers] = useState<any[]>([])
    
    useEffect(() => {
        getUsers().then(setUsers)
    }, [])
    
    const handleLogin = async (id: string) => {
        await login(id)
        window.location.href = '/'
    }
    
    return (
        <div className="flex flex-col items-center justify-center h-screen bg-gray-50 p-6">
            <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-xl w-full max-w-sm text-center">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary mx-auto mb-4">
                    <LogIn size={24} />
                </div>
                <h1 className="text-xl font-bold text-gray-900 mb-1">CRM Вход</h1>
                <p className="text-xs text-gray-500 mb-5">Выберите учетную запись для работы</p>
                
                <div className="space-y-2">
                    {users.map(u => (
                        <button 
                            key={u.id} 
                            onClick={() => handleLogin(u.id)}
                            className="w-full text-left px-4 py-3 border border-gray-100 hover:border-primary/30 hover:bg-primary/5 rounded-xl transition-all flex items-center justify-between group cursor-pointer"
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
            </div>
        </div>
    )
}
