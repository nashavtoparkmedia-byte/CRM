'use client'

import { useState, useCallback } from 'react'
import { X, Search, Check, Users, Loader2 } from 'lucide-react'
import { searchDriversForTask } from '@/app/tasks/actions'

interface DriverItem {
    id: string
    fullName: string
    phone: string | null
}

interface BulkCareModalProps {
    onClose: () => void
}

export default function BulkCareModal({ onClose }: BulkCareModalProps) {
    const [query, setQuery] = useState('')
    const [searchResults, setSearchResults] = useState<DriverItem[]>([])
    const [isSearching, setIsSearching] = useState(false)
    const [selected, setSelected] = useState<Map<string, DriverItem>>(new Map())
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [result, setResult] = useState<{ created: number; skipped: number } | null>(null)
    const [error, setError] = useState<string | null>(null)

    const handleSearch = useCallback(async (q: string) => {
        setQuery(q)
        if (q.length < 2) {
            setSearchResults([])
            return
        }
        setIsSearching(true)
        try {
            const results = await searchDriversForTask(q)
            setSearchResults(results)
        } finally {
            setIsSearching(false)
        }
    }, [])

    const toggleDriver = (driver: DriverItem) => {
        setSelected(prev => {
            const next = new Map(prev)
            if (next.has(driver.id)) {
                next.delete(driver.id)
            } else {
                next.set(driver.id, driver)
            }
            return next
        })
    }

    const removeDriver = (id: string) => {
        setSelected(prev => {
            const next = new Map(prev)
            next.delete(id)
            return next
        })
    }

    const handleSubmit = async () => {
        if (selected.size === 0) return
        setIsSubmitting(true)
        setError(null)
        try {
            const res = await fetch('/api/tasks/bulk-care', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ driverIds: Array.from(selected.keys()) }),
            })
            const data = await res.json()
            if (!res.ok) {
                setError(data.error || 'Ошибка создания задач')
                return
            }
            setResult({ created: data.created, skipped: data.skipped })
        } catch (err: any) {
            setError(err.message || 'Ошибка сети')
        } finally {
            setIsSubmitting(false)
        }
    }

    // Result screen
    if (result) {
        return (
            <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
                <div className="absolute inset-0 bg-black/40" />
                <div
                    className="relative bg-white rounded-xl w-[400px] p-6"
                    onClick={e => e.stopPropagation()}
                >
                    <div className="text-center">
                        <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
                            <Check className="w-6 h-6 text-green-600" />
                        </div>
                        <h3 className="text-[17px] font-semibold text-[#111827] mb-2">
                            Задачи созданы
                        </h3>
                        <div className="space-y-1 text-[14px] text-[#374151] mb-4">
                            <p>Создано: <span className="font-semibold text-green-600">{result.created}</span></p>
                            {result.skipped > 0 && (
                                <p>Пропущено (уже есть): <span className="font-semibold text-[#94A3B8]">{result.skipped}</span></p>
                            )}
                        </div>
                        <button
                            onClick={onClose}
                            className="px-4 py-2 rounded-lg bg-[#4f46e5] text-white text-[14px] font-medium hover:bg-[#4338ca] transition-colors"
                        >
                            Закрыть
                        </button>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
            <div className="absolute inset-0 bg-black/40" />
            <div
                className="relative bg-white rounded-xl w-[480px] max-h-[80vh] flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-[#e5e7eb]">
                    <div className="flex items-center gap-2">
                        <Users className="w-5 h-5 text-[#4f46e5]" />
                        <h3 className="text-[17px] font-semibold text-[#111827]">Массовая забота</h3>
                    </div>
                    <button onClick={onClose} className="p-1 rounded-lg hover:bg-[#f3f4f6] transition-colors">
                        <X className="w-4 h-4 text-[#6b7280]" />
                    </button>
                </div>

                {/* Search */}
                <div className="px-5 py-3 border-b border-[#f3f4f6]">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94A3B8]" />
                        <input
                            type="text"
                            value={query}
                            onChange={e => handleSearch(e.target.value)}
                            placeholder="Поиск водителей по имени или телефону..."
                            className="w-full h-[40px] pl-9 pr-3 rounded-lg border border-[#e5e7eb] text-[14px] focus:outline-none focus:border-[#4f46e5] transition-colors"
                            autoFocus
                        />
                    </div>
                    {/* Search results */}
                    {query.length >= 2 && (
                        <div className="mt-2 max-h-[180px] overflow-y-auto space-y-0.5">
                            {isSearching ? (
                                <div className="flex items-center justify-center py-3">
                                    <Loader2 className="w-4 h-4 animate-spin text-[#94A3B8]" />
                                </div>
                            ) : searchResults.length === 0 ? (
                                <p className="text-[13px] text-[#94A3B8] py-2 text-center">Не найдено</p>
                            ) : (
                                searchResults.map(driver => {
                                    const isSelected = selected.has(driver.id)
                                    return (
                                        <button
                                            key={driver.id}
                                            onClick={() => toggleDriver(driver)}
                                            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors ${
                                                isSelected
                                                    ? 'bg-indigo-50 border border-indigo-200'
                                                    : 'hover:bg-[#f3f4f6] border border-transparent'
                                            }`}
                                        >
                                            <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                                                isSelected ? 'bg-[#4f46e5] border-[#4f46e5]' : 'border-[#d1d5db]'
                                            }`}>
                                                {isSelected && <Check className="w-3 h-3 text-white" />}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="text-[13px] font-medium text-[#111827] truncate">{driver.fullName}</div>
                                                {driver.phone && (
                                                    <div className="text-[11px] text-[#94A3B8]">{driver.phone}</div>
                                                )}
                                            </div>
                                        </button>
                                    )
                                })
                            )}
                        </div>
                    )}
                </div>

                {/* Selected drivers */}
                <div className="flex-1 overflow-y-auto px-5 py-3 min-h-[60px]">
                    {selected.size === 0 ? (
                        <p className="text-[13px] text-[#94A3B8] text-center py-4">
                            Найдите и выберите водителей для создания задач заботы
                        </p>
                    ) : (
                        <>
                            <div className="text-[12px] font-medium text-[#64748B] mb-2">
                                Выбрано: {selected.size}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {Array.from(selected.values()).map(driver => (
                                    <span
                                        key={driver.id}
                                        className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-[#f1f5f9] text-[12px] text-[#374151] font-medium"
                                    >
                                        {driver.fullName.split(' ').slice(0, 2).join(' ')}
                                        <button
                                            onClick={() => removeDriver(driver.id)}
                                            className="w-3.5 h-3.5 rounded-full hover:bg-[#d1d5db] flex items-center justify-center transition-colors"
                                        >
                                            <X className="w-2.5 h-2.5 text-[#6b7280]" />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className="px-5 py-3 border-t border-[#e5e7eb] flex items-center justify-between">
                    {error && (
                        <p className="text-[12px] text-red-600 flex-1 mr-2">{error}</p>
                    )}
                    <div className="flex items-center gap-2 ml-auto">
                        <button
                            onClick={onClose}
                            className="px-3 py-2 rounded-lg text-[13px] font-medium text-[#374151] hover:bg-[#f3f4f6] transition-colors"
                        >
                            Отмена
                        </button>
                        <button
                            onClick={handleSubmit}
                            disabled={selected.size === 0 || isSubmitting}
                            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#4f46e5] text-white text-[13px] font-semibold hover:bg-[#4338ca] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isSubmitting ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <Users className="w-4 h-4" />
                            )}
                            Создать {selected.size > 0 ? `(${selected.size})` : ''}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
