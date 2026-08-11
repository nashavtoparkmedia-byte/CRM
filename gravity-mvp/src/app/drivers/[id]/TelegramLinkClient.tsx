'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Link2, Trash2 } from 'lucide-react'
import { Button } from '@/infrastructure/ui/button'
import { Input } from '@/infrastructure/ui/input'
import { Badge } from '@/infrastructure/ui/badge'

interface DriverTelegramLinkActionResult {
    success: boolean
    error?: string
    mutated?: boolean
}

interface Props {
    driverId: string
    initialTelegramId?: bigint | null
    initialUsername?: string | null
}

export default function TelegramLinkClient({ driverId, initialTelegramId, initialUsername }: Props) {
    const router = useRouter()
    const [telegramId, setTelegramId] = useState(initialTelegramId ? initialTelegramId.toString() : '')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)
    const endpoint = `/api/platform/drivers/${encodeURIComponent(driverId)}/telegram-link`

    const handleSave = async () => {
        if (!telegramId.trim()) return

        setLoading(true)
        setError(null)
        setSuccess(null)

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ telegramId }),
            })
            const res = await response.json() as DriverTelegramLinkActionResult
            if (res.success) {
                setSuccess('Telegram ID успешно привязан')
                if (res.mutated) router.refresh()
            } else {
                setError(res.error || 'Ошибка привязки')
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Ошибка сети')
        } finally {
            setLoading(false)
        }
    }

    const handleRemove = async () => {
        if (!confirm('Отвязать Telegram от этого водителя?')) return

        setLoading(true)
        setError(null)
        setSuccess(null)

        try {
            const response = await fetch(endpoint, { method: 'DELETE' })
            const res = await response.json() as DriverTelegramLinkActionResult
            if (res.success) {
                setTelegramId('')
                setSuccess('Telegram ID успешно отвязан')
                if (res.mutated) router.refresh()
            } else {
                setError(res.error || 'Ошибка отвязки')
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Ошибка сети')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="rounded-xl border p-5 space-y-[4px] bg-secondary/20 shadow-inner">
            <div className="flex items-center justify-between mb-[2px]">
                <span className="text-muted-foreground font-medium text-sm">Привязка Telegram (бот):</span>
                {initialTelegramId ? (
                    <Badge variant="success" className="text-[10px] uppercase">Привязан</Badge>
                ) : (
                    <Badge variant="secondary" className="text-[10px] uppercase">Не привязан</Badge>
                )}
            </div>

            <div className="flex gap-[2px]">
                <Input
                    placeholder="Введите Telegram ID (число)..."
                    value={telegramId}
                    onChange={(e) => setTelegramId(e.target.value.replace(/\D/g, ''))} // only digits
                    className="bg-card h-9 text-sm"
                />
                {!initialTelegramId ? (
                    <Button onClick={handleSave} disabled={loading || !telegramId} size="sm" className="h-9">
                        <Link2 className="w-[4px] h-[4px] mr-[2px]" /> Сохранить
                    </Button>
                ) : (
                    <Button onClick={handleRemove} disabled={loading} size="sm" variant="destructive" className="h-9">
                        <Trash2 className="w-[4px] h-[4px] mr-[2px]" /> Отвязать
                    </Button>
                )}
            </div>

            {error && <div className="text-red-500 text-xs">{error}</div>}
            {success && <div className="text-green-600 text-xs">{success}</div>}

            {initialUsername && (
                <div className="text-xs text-muted-foreground mt-[2px]">
                    Username: @{initialUsername}
                </div>
            )}
            <div className="text-xs text-muted-foreground mt-[2px]">
                Водитель сможет управлять лимитами через Telegram бота.
            </div>
        </div>
    )
}
