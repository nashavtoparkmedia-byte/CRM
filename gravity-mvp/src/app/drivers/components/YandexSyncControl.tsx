"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import { RefreshCw, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react"
import { getYandexSyncStatus, triggerYandexSync } from "../segmentation-actions"

interface SyncStatusView {
    lastRunAt: string | null
    status: 'success' | 'error' | 'running' | 'never'
    errorMessage: string | null
    driversUpdated: number | null
    ordersProcessed: number | null
    cooldownRemainingMs: number
}

interface Toast {
    message: string
    type: 'success' | 'error' | 'info'
}

/**
 * Shows the latest Yandex Fleet sync status and exposes a manual "Обновить"
 * button. Kept self-contained so DriversClient stays readable.
 */
export function YandexSyncControl() {
    const [status, setStatus] = useState<SyncStatusView | null>(null)
    const [isClicking, setIsClicking] = useState(false)
    const [toast, setToast] = useState<Toast | null>(null)
    const pollingRef = useRef<NodeJS.Timeout | null>(null)

    const fetchStatus = useCallback(async () => {
        try {
            const s = await getYandexSyncStatus() as SyncStatusView
            setStatus(s)
            return s
        } catch (e) {
            return null
        }
    }, [])

    // Initial load + clear polling on unmount
    useEffect(() => {
        fetchStatus()
        return () => {
            if (pollingRef.current) clearInterval(pollingRef.current)
        }
    }, [fetchStatus])

    // Auto-toast dismiss
    useEffect(() => {
        if (!toast) return
        const t = setTimeout(() => setToast(null), 5000)
        return () => clearTimeout(t)
    }, [toast])

    // While a sync is running, poll every 3s until status changes.
    useEffect(() => {
        if (status?.status !== 'running') {
            if (pollingRef.current) {
                clearInterval(pollingRef.current)
                pollingRef.current = null
            }
            return
        }
        if (pollingRef.current) return
        pollingRef.current = setInterval(async () => {
            const s = await fetchStatus()
            if (s && s.status !== 'running') {
                if (pollingRef.current) {
                    clearInterval(pollingRef.current)
                    pollingRef.current = null
                }
            }
        }, 3000)
    }, [status?.status, fetchStatus])

    const handleClick = async () => {
        if (isClicking) return
        if (status?.status === 'running') return
        setIsClicking(true)
        try {
            const result = await triggerYandexSync()
            if (result.ok) {
                setToast({
                    message: `Обновлено: ${result.driversUpdated ?? 0} водителей, ${result.ordersProcessed ?? 0} поездок`,
                    type: 'success'
                })
            } else if (result.reason === 'already_running') {
                setToast({ message: 'Обновление уже идёт...', type: 'info' })
            } else if (result.reason === 'cooldown') {
                const sec = Math.ceil((result.cooldownRemainingMs || 0) / 1000)
                setToast({ message: `Слишком часто. Подождите ${sec} сек.`, type: 'info' })
            } else {
                setToast({
                    message: `Ошибка синхронизации: ${result.errorMessage || 'неизвестно'}`,
                    type: 'error'
                })
            }
            await fetchStatus()
        } finally {
            setIsClicking(false)
        }
    }

    const formatTime = (iso: string | null) => {
        if (!iso) return null
        const d = new Date(iso)
        const now = new Date()
        const sameDay = d.toDateString() === now.toDateString()
        const yesterday = new Date(now)
        yesterday.setDate(now.getDate() - 1)
        const isYesterday = d.toDateString() === yesterday.toDateString()

        const hh = String(d.getHours()).padStart(2, '0')
        const mm = String(d.getMinutes()).padStart(2, '0')

        if (sameDay) return `сегодня в ${hh}:${mm}`
        if (isYesterday) return `вчера в ${hh}:${mm}`

        const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
        return `${d.getDate()} ${months[d.getMonth()]} в ${hh}:${mm}`
    }

    const isRunning = status?.status === 'running'
    const isError = status?.status === 'error'
    const buttonDisabled = isClicking || isRunning

    let statusIcon: React.ReactNode = null
    let statusText: React.ReactNode = null

    if (!status) {
        // loading initial state — render nothing to avoid flash
        statusText = null
    } else if (isRunning) {
        statusIcon = <Loader2 size={12} className="text-[#3390EC] animate-spin" />
        statusText = <span className="text-[12px] text-[#3390EC] font-medium">Идёт обновление...</span>
    } else if (status.status === 'never') {
        statusIcon = <AlertTriangle size={12} className="text-amber-500" />
        statusText = <span className="text-[12px] text-[#8A9099] font-medium">Ещё не синхронизировалось</span>
    } else if (isError) {
        statusIcon = <AlertTriangle size={12} className="text-red-500" />
        statusText = (
            <span
                className="text-[12px] text-red-500 font-medium truncate max-w-[280px]"
                title={status.errorMessage || ''}
            >
                Ошибка{status.lastRunAt ? ` (${formatTime(status.lastRunAt)})` : ''}
            </span>
        )
    } else {
        statusIcon = <CheckCircle2 size={12} className="text-emerald-500" />
        statusText = (
            <span className="text-[12px] text-[#8A9099] font-medium">
                Обновлено {formatTime(status.lastRunAt)}
            </span>
        )
    }

    return (
        <>
            <div className="flex items-center gap-2">
                {statusText && (
                    <div className="flex items-center gap-1.5">
                        {statusIcon}
                        {statusText}
                    </div>
                )}
                <button
                    onClick={handleClick}
                    disabled={buttonDisabled}
                    className="h-[36px] px-3 rounded-lg bg-[#F4F5F7] hover:bg-[#EBEDF0] disabled:opacity-50 disabled:cursor-not-allowed text-[13px] font-semibold text-[#111] flex items-center gap-2 transition-colors"
                    title={isRunning ? 'Идёт обновление...' : 'Обновить данные из Яндекс.Флит'}
                >
                    <RefreshCw
                        size={14}
                        className={isRunning ? 'animate-spin text-[#3390EC]' : 'text-[#8A9099]'}
                    />
                    {isRunning ? 'Обновляем...' : 'Обновить'}
                </button>
            </div>

            {toast && (
                <div
                    className={`fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-lg shadow-lg text-[13px] font-medium animate-in slide-in-from-bottom-4 duration-200 z-[120] max-w-[480px] ${
                        toast.type === 'success' ? 'bg-emerald-500 text-white' :
                        toast.type === 'error' ? 'bg-red-500 text-white' :
                        'bg-[#3390EC] text-white'
                    }`}
                >
                    {toast.message}
                </div>
            )}
        </>
    )
}
