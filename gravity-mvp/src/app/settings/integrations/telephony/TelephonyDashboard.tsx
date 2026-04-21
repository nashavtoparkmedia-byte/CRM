"use client"

import { useState, useEffect } from "react"
import { Phone, PhoneOff, Wifi, WifiOff, Trash2 } from "lucide-react"

interface TelephonyDevice {
    id: string
    androidId: string
    name: string
    phoneNumber: string | null
    simOperator: string | null
    status: 'online' | 'offline'
    isActive: boolean
    revokedAt: string | null
    lastHeartbeat: string | null
    appVersion: string | null
    createdAt: string
}

function relativeTime(dateStr: string | null): string {
    if (!dateStr) return 'никогда'
    const diff = Date.now() - new Date(dateStr).getTime()
    if (diff < 60_000) return 'только что'
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} мин назад`
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} ч назад`
    return new Date(dateStr).toLocaleDateString('ru-RU')
}

export default function TelephonyDashboard() {
    const [devices, setDevices] = useState<TelephonyDevice[]>([])
    const [loading, setLoading] = useState(true)
    const [revoking, setRevoking] = useState<string | null>(null)

    const fetchDevices = async () => {
        try {
            const res = await fetch('/api/telephony/devices')
            if (res.ok) setDevices(await res.json())
        } catch (err) {
            console.error('Failed to fetch devices', err)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        fetchDevices()
        const interval = setInterval(fetchDevices, 10_000)
        return () => clearInterval(interval)
    }, [])

    const handleRevoke = async (deviceId: string) => {
        if (!confirm('Отключить устройство? Все ожидающие команды будут отменены.')) return
        setRevoking(deviceId)
        try {
            await fetch(`/api/telephony/devices/${deviceId}/revoke`, { method: 'POST' })
            await fetchDevices()
        } finally {
            setRevoking(null)
        }
    }

    if (loading) {
        return (
            <div className="space-y-3">
                {[1, 2].map(i => (
                    <div key={i} className="h-20 rounded-xl bg-surface animate-pulse" />
                ))}
            </div>
        )
    }

    if (devices.length === 0) {
        return (
            <div className="flex flex-col items-center py-16 text-center">
                <div className="w-16 h-16 rounded-full bg-orange-50 flex items-center justify-center mb-4">
                    <Phone size={28} className="text-orange-400" />
                </div>
                <h3 className="text-lg font-semibold text-foreground">Нет подключённых устройств</h3>
                <p className="text-sm text-muted mt-2 max-w-sm">
                    Установите Android-приложение и зарегистрируйте устройство через API.
                </p>
                <div className="mt-6 p-4 bg-surface rounded-xl border border-border text-left text-sm max-w-md">
                    <div className="font-medium text-foreground mb-1">URL сервера для Android-приложения:</div>
                    <code className="text-xs text-muted font-mono break-all">
                        {typeof window !== 'undefined' ? window.location.origin : ''}
                    </code>
                </div>
            </div>
        )
    }

    return (
        <div className="space-y-3">
            {devices.map(device => {
                const isRevoked = !device.isActive
                const isOnline = device.status === 'online' && !isRevoked

                return (
                    <div
                        key={device.id}
                        className={`flex items-center gap-4 p-4 rounded-xl border transition-colors ${
                            isRevoked
                                ? 'bg-gray-50 border-gray-200 opacity-60'
                                : 'bg-white border-border hover:border-orange-200'
                        }`}
                    >
                        {/* Status icon */}
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                            isRevoked ? 'bg-red-50' :
                            isOnline ? 'bg-green-50' : 'bg-gray-100'
                        }`}>
                            {isRevoked ? (
                                <PhoneOff size={18} className="text-red-400" />
                            ) : isOnline ? (
                                <Wifi size={18} className="text-green-500" />
                            ) : (
                                <WifiOff size={18} className="text-gray-400" />
                            )}
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="font-medium text-sm text-foreground truncate">{device.name}</span>
                                {isRevoked && (
                                    <span className="text-[10px] font-bold text-red-500 bg-red-50 px-1.5 py-0.5 rounded">
                                        ОТКЛЮЧЕНО
                                    </span>
                                )}
                                {!isRevoked && (
                                    <span className={`w-2 h-2 rounded-full shrink-0 ${isOnline ? 'bg-green-500' : 'bg-gray-300'}`} />
                                )}
                            </div>
                            <div className="flex items-center gap-3 text-xs text-muted mt-0.5">
                                {device.phoneNumber && <span className="font-mono">{device.phoneNumber}</span>}
                                {device.simOperator && <span>{device.simOperator}</span>}
                                {device.appVersion && <span>v{device.appVersion}</span>}
                                <span>Связь: {relativeTime(device.lastHeartbeat)}</span>
                            </div>
                        </div>

                        {/* Actions */}
                        {!isRevoked && (
                            <button
                                onClick={() => handleRevoke(device.id)}
                                disabled={revoking === device.id}
                                className="h-9 px-3 rounded-lg border border-border text-sm text-muted hover:text-red-600 hover:border-red-200 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                            >
                                <Trash2 size={14} />
                                Отключить
                            </button>
                        )}

                        {isRevoked && (
                            <div className="text-xs text-muted">
                                {device.revokedAt && relativeTime(device.revokedAt)}
                            </div>
                        )}
                    </div>
                )
            })}

            {/* Server URL info */}
            <div className="mt-6 p-4 bg-surface rounded-xl border border-border text-sm">
                <div className="font-medium text-foreground mb-1">URL сервера для Android-приложения:</div>
                <code className="text-xs text-muted font-mono break-all">
                    {typeof window !== 'undefined' ? window.location.origin : ''}
                </code>
            </div>
        </div>
    )
}
