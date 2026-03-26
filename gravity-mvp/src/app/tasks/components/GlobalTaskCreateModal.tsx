'use client'

import { useState, useEffect } from 'react'
import { X, Search, User } from 'lucide-react'
import TaskCreateModal from './TaskCreateModal'
import { searchDriversForTask } from '@/app/tasks/actions'

export default function GlobalTaskCreateModal({ onClose }: { onClose: () => void }) {
    const [searchQuery, setSearchQuery] = useState('')
    const [debouncedQuery, setDebouncedQuery] = useState('')
    const [drivers, setDrivers] = useState<Array<{ id: string, fullName: string, phone: string | null }>>([])
    const [isSearching, setIsSearching] = useState(false)

    const [selectedDriver, setSelectedDriver] = useState<{ id: string, fullName: string } | null>(null)

    // Basic debounce
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedQuery(searchQuery)
        }, 300)
        return () => clearTimeout(timer)
    }, [searchQuery])

    // Fetch drivers
    useEffect(() => {
        if (debouncedQuery.length < 2) {
            setDrivers([])
            return
        }

        let isMounted = true
        async function fetchDocs() {
            setIsSearching(true)
            try {
                const results = await searchDriversForTask(debouncedQuery)
                if (isMounted) setDrivers(results)
            } catch (err) {
                console.error(err)
            } finally {
                if (isMounted) setIsSearching(false)
            }
        }
        fetchDocs()
        return () => { isMounted = false }
    }, [debouncedQuery])

    if (selectedDriver) {
        return (
            <TaskCreateModal 
                driverId={selectedDriver.id}
                driverName={selectedDriver.fullName}
                source="manual"
                onClose={onClose}
            />
        )
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-[#e5e7eb] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-[#f0f0f0]">
                    <div>
                        <h2 className="text-[17px] font-bold text-[#1f2937]">Новая задача</h2>
                        <p className="text-[13px] text-[#6b7280]">Выберите водителя для постановки задачи</p>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-lg hover:bg-[#f3f4f6] transition-colors text-[#9ca3af]"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Body */}
                <div className="p-5 h-[300px] flex flex-col">
                    <div className="relative mb-4">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <input
                            autoFocus
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            placeholder="Поиск по имени или телефону..."
                            className="w-full h-[40px] pl-9 pr-3 bg-[#f9fafb] border border-[#d1d5db] rounded-lg text-[14px] outline-none focus:border-[#4f46e5]"
                        />
                    </div>

                    <div className="flex-1 overflow-y-auto custom-scrollbar">
                        {isSearching ? (
                            <div className="flex justify-center py-8 text-sm text-gray-400">Поиск...</div>
                        ) : drivers.length > 0 ? (
                            <div className="space-y-1">
                                {drivers.map(d => (
                                    <button
                                        key={d.id}
                                        onClick={() => setSelectedDriver({ id: d.id, fullName: d.fullName })}
                                        className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-indigo-50 transition-colors text-left group"
                                    >
                                        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-500 shrink-0">
                                            <User size={14} />
                                        </div>
                                        <div>
                                            <div className="text-[14px] font-semibold text-gray-900 group-hover:text-indigo-700">{d.fullName}</div>
                                            {d.phone && <div className="text-[12px] text-gray-500 font-mono mt-0.5">{d.phone}</div>}
                                        </div>
                                    </button>
                                ))}
                            </div>
                        ) : searchQuery.length >= 2 ? (
                            <div className="text-center py-8 text-[13px] text-gray-400">Ничего не найдено</div>
                        ) : (
                            <div className="text-center py-8 text-[13px] text-gray-400">Введите имя или телефон водителя</div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}
