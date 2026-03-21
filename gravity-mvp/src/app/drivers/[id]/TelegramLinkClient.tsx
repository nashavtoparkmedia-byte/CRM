'use client'

import { useState } from 'react'
import { Link2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { saveDriverTelegramLink, removeDriverTelegramLink } from './actions'

interface Props {
    driverId: string
    initialTelegramId?: bigint | null
    initialUsername?: string | null
}

export default function TelegramLinkClient({ driverId, initialTelegramId, initialUsername }: Props) {
    const [telegramId, setTelegramId] = useState(initialTelegramId ? initialTelegramId.toString() : '')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)

    const handleSave = async () => {
        if (!telegramId.trim()) return

        setLoading(true)
        setError(null)
        setSuccess(null)

        try {
            const res = await saveDriverTelegramLink(driverId, telegramId)
            if (res.success) {
                setSuccess('Telegram ID успешно привязан')
            } else {
                setError(res.error || 'Ошибка привязки')
            }
        } catch (err: any) {
            setError(err.message || 'Ошибка сети')
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
            const res = await removeDriverTelegramLink(driverId)
            if (res.success) {
                setTelegramId('')
                setSuccess('Telegram ID успешно отвязан')
            } else {
                setError(res.error || 'Ошибка отвязки')
            }
        } catch (err: any) {
            setError(err.message || 'Ошибка сети')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="rounded-xl border p-5 space-y-4 bg-secondary/20 shadow-inner">
            <div className="flex items-center justify-between mb-2">
                <span className="text-muted-foreground font-medium text-sm">Привязка Telegram (бот):</span>
                {initialTelegramId ? (
                    <Badge variant="success" className="text-[10px] uppercase">Привязан</Badge>
                ) : (
                    <Badge variant="secondary" className="text-[10px] uppercase">Не привязан</Badge>
                )}
            </div>

            <div className="flex gap-2">
                <Input
                    placeholder="Введите Telegram ID (число)..."
                    value={telegramId}
                    onChange={(e) => setTelegramId(e.target.value.replace(/\D/g, ''))} // only digits
                    className="bg-card h-9 text-sm"
                />
                {!initialTelegramId ? (
                    <Button onClick={handleSave} disabled={loading || !telegramId} size="sm" className="h-9">
                        <Link2 className="w-4 h-4 mr-2" /> Сохранить
                    </Button>
                ) : (
                    <Button onClick={handleRemove} disabled={loading} size="sm" variant="destructive" className="h-9">
                        <Trash2 className="w-4 h-4 mr-2" /> Отвязать
                    </Button>
                )}
            </div>

            {error && <div className="text-red-500 text-xs">{error}</div>}
            {success && <div className="text-green-600 text-xs">{success}</div>}

            {initialUsername && (
                <div className="text-xs text-muted-foreground mt-2">
                    Username: @{initialUsername}
                </div>
            )}
            <div className="text-xs text-muted-foreground mt-2">
                Водитель сможет управлять лимитами через Telegram бота.
            </div>
        </div>
    )
}
