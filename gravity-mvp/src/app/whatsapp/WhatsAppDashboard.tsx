'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Trash2, Loader2, MessageCircle, Wifi, WifiOff, RefreshCw, AlertTriangle, X, Check } from 'lucide-react'
import { createWhatsAppConnection, getWhatsAppConnections, getWhatsAppStatus, disconnectWhatsApp, refreshWhatsAppQR } from './whatsapp-actions'

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

type WaConnection = {
    id: string
    name: string | null
    status: string
    phoneNumber: string | null
    sessionData: string | null
}

function StatusBadge({ status }: { status: string }) {
    const map: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" | "success" | "warning" }> = {
        idle: { label: 'Ожидание', variant: 'outline' },
        qr: { label: 'Сканируйте QR', variant: 'warning' },
        qr_expired: { label: 'QR Истек', variant: 'destructive' },
        authenticated: { label: 'Подключение...', variant: 'default' },
        ready: { label: 'Подключено', variant: 'success' },
        disconnected: { label: 'Отключено', variant: 'destructive' },
        error: { label: 'Ошибка', variant: 'destructive' },
    }
    const s = map[status] || { label: status, variant: 'outline' }

    // Fallback classes if custom variants aren't added to badge yet
    let className = "uppercase text-[10px] "
    if (s.variant === 'warning') className += "bg-yellow-100 text-yellow-800 hover:bg-yellow-200 border-none"
    else if (s.variant === 'success') className += "bg-green-100 text-green-800 hover:bg-green-200 border-none"
    else if (s.variant === 'destructive') className += "bg-red-100 text-red-800 hover:bg-red-200 border-none"

    return <Badge variant={s.variant as any} className={className}>{s.label}</Badge>
}

function ConnectionCard({ conn, onRefresh }: { conn: WaConnection; onRefresh: () => void }) {
    const [isClient, setIsClient] = useState(false)
    const [loading, setLoading] = useState(false)
    const [showConfirm, setShowConfirm] = useState(false)
    const [liveStatus, setLiveStatus] = useState(conn.status)
    const [liveQr, setLiveQr] = useState<string | null>(null)
    const pollingRef = useRef<NodeJS.Timeout | null>(null)

    useEffect(() => {
        setIsClient(true)
    }, [])

    useEffect(() => {
        setLiveStatus(conn.status)
        if (conn.status === 'qr' && conn.sessionData?.startsWith('data:')) {
            setLiveQr(conn.sessionData)
        }
    }, [conn])

    useEffect(() => {
        if (!isClient) return
        const shouldPoll = ['idle', 'qr', 'qr_expired', 'authenticated'].includes(liveStatus)
        if (shouldPoll) {
            pollingRef.current = setInterval(async () => {
                const fresh = await getWhatsAppStatus(conn.id)
                if (!fresh) return
                setLiveStatus(fresh.status)
                if (fresh.status === 'qr' && fresh.sessionData?.startsWith('data:')) {
                    setLiveQr(fresh.sessionData)
                }
                if (fresh.status === 'ready') {
                    if (pollingRef.current) clearInterval(pollingRef.current)
                    onRefresh()
                }
            }, 3000)
        } else {
            if (pollingRef.current) clearInterval(pollingRef.current)
        }
        return () => { if (pollingRef.current) clearInterval(pollingRef.current) }
    }, [liveStatus, conn.id, onRefresh, isClient])

    const handleDisconnect = async () => {
        if (!confirm('Отключить этот аккаунт WhatsApp?')) return
        setLoading(true)
        await disconnectWhatsApp(conn.id)
        setLiveStatus('idle')
        onRefresh()
        setLoading(false)
    }

    const handleDelete = async () => {
        setLoading(true)
        try {
            const resp = await fetch('/api/whatsapp/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: conn.id })
            })

            if (!resp.ok) {
                const data = await resp.json()
                throw new Error(data.error || 'Server error')
            }

            onRefresh()
        } catch (err: any) {
            console.error('Delete failed:', err)
            alert(`Delete failed: ${err.message}`)
        } finally {
            setLoading(false)
            setShowConfirm(false)
        }
    }

    if (!isClient) {
        return <div className="h-[250px] animate-pulse rounded-xl border bg-muted/50 p-6" />
    }

    return (
        <div className="flex flex-col gap-4 rounded-xl border bg-card p-6 shadow-sm transition-all hover:shadow-md">
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-lg font-bold text-foreground">{conn.name || 'WhatsApp Аккаунт'}</h3>
                    {conn.phoneNumber && <p className="mt-0.5 text-sm font-medium text-muted-foreground">+{conn.phoneNumber}</p>}
                </div>
                <StatusBadge status={liveStatus} />
            </div>

            {/* QR Display */}
            {(liveStatus === 'qr' || liveStatus === 'qr_expired') && (
                <div className="flex flex-col items-center gap-3 py-4">
                    {liveStatus === 'qr_expired' ? (
                        <div className="text-center text-orange-600">
                            <AlertTriangle size={40} className="mx-auto mb-2" />
                            <p className="text-sm font-medium">QR код истек. Пожалуйста, переподключитесь.</p>
                        </div>
                    ) : liveQr ? (
                        <>
                            <div className="rounded-2xl border-4 border-muted bg-white p-3 shadow-sm">
                                <img src={liveQr} alt="WhatsApp QR Code" className="h-[180px] w-[180px]" />
                            </div>
                            <p className="max-w-[200px] text-center text-xs text-muted-foreground">
                                Откройте WhatsApp → Настройки → Связанные устройства → Привязка устройства
                            </p>
                            <div className="flex items-center gap-2 text-xs font-bold text-yellow-600">
                                <Loader2 size={14} className="animate-spin" />
                                Ожидание сканирования...
                            </div>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={async () => {
                                    setLoading(true)
                                    setLiveQr(null)
                                    await refreshWhatsAppQR(conn.id)
                                    setLoading(false)
                                }}
                                disabled={loading}
                                className="mt-2"
                            >
                                <RefreshCw size={14} className="mr-2" /> Обновить QR
                            </Button>
                        </>
                    ) : (
                        <Loader2 size={40} className="mx-auto animate-spin text-primary" />
                    )}
                </div>
            )}

            {/* Connecting */}
            {liveStatus === 'authenticated' && (
                <div className="flex items-center gap-3 py-4 text-blue-600">
                    <Loader2 size={18} className="animate-spin" />
                    <span className="text-sm font-medium">Завершение аутентификации...</span>
                </div>
            )}

            {/* Connected */}
            {liveStatus === 'ready' && (
                <div className="flex items-center gap-3 py-4 text-green-600">
                    <CheckCircle2 size={20} />
                    <span className="text-sm font-medium">Аккаунт подключен и готов к работе</span>
                </div>
            )}

            {/* Warning */}
            {liveStatus === 'ready' && (
                <div className="flex gap-3 rounded-xl border border-yellow-200 bg-yellow-50 p-3">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0 text-yellow-600" />
                    <p className="text-xs text-yellow-800">
                        <b>Используйте ответственно.</b> Массовые рассылки могут привести к блокировке аккаунта WhatsApp. Избегайте спама.
                    </p>
                </div>
            )}

            {/* Actions */}
            <div className="mt-auto flex gap-2 pt-4">
                {!showConfirm ? (
                    <>
                        {liveStatus === 'ready' && (
                            <Button
                                variant="destructive"
                                onClick={handleDisconnect}
                                disabled={loading}
                                className="flex-1 bg-red-100 text-red-700 hover:bg-red-200"
                            >
                                <WifiOff size={16} className="mr-2" /> Отключить
                            </Button>
                        )}
                        {(liveStatus === 'idle' || liveStatus === 'disconnected' || liveStatus === 'error') && (
                            <Button
                                onClick={async () => { setLoading(true); await createWhatsAppConnection(conn.name || undefined); onRefresh(); setLoading(false) }}
                                disabled={loading}
                                className="flex-1"
                            >
                                {loading ? <Loader2 size={16} className="animate-spin" /> : <><Wifi size={16} className="mr-2" /> Переподключить</>}
                            </Button>
                        )}
                        <Button
                            variant="outline"
                            size="icon"
                            onClick={() => setShowConfirm(true)}
                            disabled={loading}
                            className="text-muted-foreground hover:text-destructive"
                        >
                            <Trash2 size={16} />
                        </Button>
                    </>
                ) : (
                    <div className="flex flex-1 animate-in slide-in-from-right-2 gap-2">
                        <Button
                            variant="destructive"
                            onClick={handleDelete}
                            disabled={loading}
                            className="flex-1"
                        >
                            {loading ? <Loader2 size={16} className="animate-spin" /> : <><Check size={16} className="mr-2" /> Подтвердить</>}
                        </Button>
                        <Button
                            variant="outline"
                            size="icon"
                            onClick={() => setShowConfirm(false)}
                            disabled={loading}
                        >
                            <X size={16} />
                        </Button>
                    </div>
                )}
            </div>
        </div>
    )
}

export function WhatsAppDashboard({ initialConnections }: { initialConnections: WaConnection[] }) {
    const router = useRouter()
    const [isClient, setIsClient] = useState(false)
    const [connections, setConnections] = useState(initialConnections)
    const [adding, setAdding] = useState(false)

    useEffect(() => {
        setIsClient(true)
    }, [])

    const refresh = async () => {
        const fresh = await getWhatsAppConnections()
        setConnections(fresh as WaConnection[])
        router.refresh()
    }

    const handleAdd = async () => {
        setAdding(true)
        await createWhatsAppConnection()
        await refresh()
        setAdding(false)
    }

    if (!isClient) return (
        <div className="space-y-8 animate-pulse p-2">
            <div className="h-10 w-48 rounded-lg bg-muted" />
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <div className="h-[250px] rounded-xl bg-muted" />
                <div className="h-[250px] rounded-xl bg-muted" />
            </div>
        </div>
    )

    return (
        <div className="flex w-full flex-col gap-6 animate-in fade-in duration-500">
            <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end p-2">
                <div>
                    <h1 className="mb-2 text-3xl font-bold text-foreground">Интеграция WhatsApp</h1>
                    <p className="text-sm text-muted-foreground">
                        Подключите ваши личные аккаунты WhatsApp для отправки сообщений водителям прямо из CRM.
                    </p>
                </div>
                <Button onClick={handleAdd} disabled={adding} className="h-11 px-6">
                    {adding ? <Loader2 size={18} className="mr-2 animate-spin" /> : <MessageCircle size={18} className="mr-2" />}
                    Добавить Аккаунт
                </Button>
            </div>

            {connections.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed p-12 text-center bg-card">
                    <div className="rounded-full bg-secondary p-4 mb-4">
                        <MessageCircle size={32} className="text-muted-foreground" />
                    </div>
                    <h3 className="mb-2 text-xl font-bold text-foreground">Нет подключенных аккаунтов</h3>
                    <p className="mb-6 max-w-sm text-sm text-muted-foreground">
                        Добавьте ваш первый аккаунт WhatsApp, отсканировав QR-код в приложении телефона.
                    </p>
                    <Button onClick={handleAdd} disabled={adding} size="lg">
                        {adding ? <Loader2 size={18} className="mr-2 animate-spin" /> : 'Добавить Аккаунт'}
                    </Button>
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                    {connections.map(conn => (
                        <ConnectionCard key={conn.id} conn={conn} onRefresh={refresh} />
                    ))}
                </div>
            )}
        </div>
    )
}
