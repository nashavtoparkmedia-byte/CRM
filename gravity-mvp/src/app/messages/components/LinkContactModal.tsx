"use client"

import { useState, useEffect, useRef } from "react"
import { X, Search, UserCheck } from "lucide-react"
import { searchDriversForLinking, linkChatToDriverManually, DriverSearchResult } from "../link-chat-actions"

/**
 * PR-О: Modal для привязки chat'а к водителю.
 *
 * Открывается по клику на badge «Не привязан» в ChatHeader.
 * Поиск по ФИО или телефону → выбор → привязка.
 */
interface Props {
    chatId: string
    isOpen: boolean
    onClose: () => void
    onLinked?: () => void
}

export default function LinkContactModal({ chatId, isOpen, onClose, onLinked }: Props) {
    const [query, setQuery] = useState('')
    const [results, setResults] = useState<DriverSearchResult[]>([])
    const [loading, setLoading] = useState(false)
    const [linking, setLinking] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    // Debounced search
    useEffect(() => {
        if (!isOpen) return
        if (query.trim().length < 2) {
            setResults([])
            return
        }
        const handle = setTimeout(async () => {
            setLoading(true)
            try {
                const r = await searchDriversForLinking(query)
                setResults(r)
            } catch (e: any) {
                setError(e.message)
            } finally {
                setLoading(false)
            }
        }, 200)
        return () => clearTimeout(handle)
    }, [query, isOpen])

    // Focus on open
    useEffect(() => {
        if (isOpen) {
            setQuery('')
            setResults([])
            setError(null)
            setTimeout(() => inputRef.current?.focus(), 50)
        }
    }, [isOpen])

    const handleLink = async (driverId: string) => {
        setLinking(driverId)
        setError(null)
        try {
            const r = await linkChatToDriverManually(chatId, driverId)
            if ('error' in r) {
                setError(r.error)
            } else {
                onLinked?.()
                onClose()
            }
        } catch (e: any) {
            setError(e.message)
        } finally {
            setLinking(null)
        }
    }

    if (!isOpen) return null

    return (
        <div
            className="fixed inset-0 bg-black/40 z-[100] flex items-start justify-center pt-[15vh]"
            onClick={onClose}
        >
            <div
                className="bg-white rounded-xl shadow-xl w-full max-w-[480px] max-h-[70vh] flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
                    <h3 className="font-semibold text-[17px] text-[#111]">Привязать к водителю</h3>
                    <button
                        onClick={onClose}
                        className="p-1 rounded-md hover:bg-gray-100 text-gray-400"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Search input */}
                <div className="px-5 py-3 border-b border-gray-100">
                    <div className="flex items-center bg-[#F1F5FD] rounded-lg px-3 h-[40px]">
                        <Search size={16} className="text-gray-400 shrink-0" />
                        <input
                            ref={inputRef}
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Поиск по ФИО или телефону..."
                            className="bg-transparent border-none outline-none text-[14px] flex-1 px-2"
                        />
                    </div>
                    {error && (
                        <div className="text-[12px] text-red-600 mt-2 font-medium">{error}</div>
                    )}
                </div>

                {/* Results */}
                <div className="flex-1 overflow-y-auto">
                    {query.trim().length < 2 && (
                        <div className="px-5 py-8 text-center text-[13px] text-gray-400">
                            Начните вводить имя или телефон
                        </div>
                    )}
                    {loading && (
                        <div className="px-5 py-8 text-center text-[13px] text-gray-400">
                            Поиск...
                        </div>
                    )}
                    {!loading && query.trim().length >= 2 && results.length === 0 && (
                        <div className="px-5 py-8 text-center text-[13px] text-gray-400">
                            Ничего не найдено
                        </div>
                    )}
                    {results.map((d) => (
                        <button
                            key={d.id}
                            onClick={() => handleLink(d.id)}
                            disabled={linking !== null}
                            className="w-full px-5 py-3 flex items-center gap-3 hover:bg-[#F1F5FD] transition-colors text-left border-b border-gray-50 disabled:opacity-50"
                        >
                            <div className="w-9 h-9 rounded-full bg-[#2AABEE] text-white flex items-center justify-center font-semibold text-[14px] shrink-0">
                                {d.fullName.charAt(0).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="font-medium text-[14px] text-[#111] truncate">{d.fullName}</div>
                                {d.phone && (
                                    <div className="text-[12px] text-gray-500 truncate">{d.phone}</div>
                                )}
                            </div>
                            {linking === d.id ? (
                                <div className="text-[12px] text-gray-400">Привязываю...</div>
                            ) : (
                                <UserCheck size={16} className="text-[#2AABEE] shrink-0" />
                            )}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    )
}
