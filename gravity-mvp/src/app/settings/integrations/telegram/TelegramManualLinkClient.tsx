'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getUnlinkedTelegramUsers, linkTelegramUserToDriver } from '../../../tg-bot-actions'
import { getDrivers } from '../../../actions'
import { Link2, Search, UserCheck } from 'lucide-react'

export default function TelegramManualLinkClient() {
    const [unlinkedUsers, setUnlinkedUsers] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState('')
    const [drivers, setDrivers] = useState<any[]>([])
    const [selectedTgId, setSelectedTgId] = useState<string | null>(null)
    const [linking, setLinking] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)

    useEffect(() => {
        loadData()
    }, [])

    const loadData = async () => {
        setLoading(true)
        try {
            const users = await getUnlinkedTelegramUsers()
            setUnlinkedUsers(users)
        } catch (err) {
            console.error("Failed to load unlinked users:", err)
        } finally {
            setLoading(false)
        }
    }

    const handleSearch = async () => {
        if (!searchQuery) return
        try {
            const res = await fetch(`/api/drivers-search?q=${encodeURIComponent(searchQuery)}`)
            if (!res.ok) throw new Error(await res.text())
            const data = await res.json()
            setDrivers(data.drivers || [])
            if ((data.drivers || []).length === 0) {
                setError('Водители не найдены. Попробуйте другой запрос.')
            } else {
                setError(null)
            }
        } catch (err: any) {
            console.error("Failed to search drivers:", err)
            setError(`Ошибка поиска: ${err.message}`)
        }
    }

    const handleLink = async (driverId: string, driverName: string) => {
        if (!selectedTgId) return

        if (!confirm(`Вы действительно хотите привязать Telegram ID ${selectedTgId} к водителю ${driverName}?`)) return

        setLinking(true)
        setError(null)
        setSuccess(null)

        try {
            const result = await linkTelegramUserToDriver(selectedTgId, driverId)
            if (result.success) {
                setSuccess(`Успешно привязано к ${driverName}`)
                setSelectedTgId(null)
                setSearchQuery('')
                setDrivers([])
                await loadData() // Refresh list
            } else {
                setError(result.error || 'Ошибка привязки')
            }
        } catch (err: any) {
            setError(err.message || 'Ошибка сети')
        } finally {
            setLinking(false)
        }
    }

    return (
        <Card className="animate-in fade-in duration-500 w-full">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <UserCheck className="w-5 h-5" />
                    Ручная привязка Telegram-Бота
                </CardTitle>
                <CardDescription>
                    Ниже показаны пользователи, которые написали в бот, но еще не привязаны к профилю водителя в Яндексе.
                    Выберите ID и найдите нужного водителя, чтобы связать их.
                </CardDescription>
            </CardHeader>
            <CardContent>
                {loading ? (
                    <div className="text-sm text-muted-foreground p-4 text-center">Загрузка...</div>
                ) : unlinkedUsers.length === 0 ? (
                    <div className="text-sm text-muted-foreground p-4 text-center border rounded-lg bg-secondary/20">
                        Нет нераспознанных пользователей. Все, кто писал в бот — привязаны.
                    </div>
                ) : (
                    <div className="space-y-6">
                        {/* Step 1: Select Unlinked User */}
                        <h3 className="text-sm font-semibold mb-3 tracking-wide">1. Выберите чат в Telegram:</h3>
                        <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
                            {unlinkedUsers.map(user => (
                                <div
                                    key={user.telegramId}
                                    onClick={() => setSelectedTgId(user.telegramId)}
                                    className={`p-3 border rounded-lg cursor-pointer transition-colors text-sm
                                        ${selectedTgId === user.telegramId ? 'border-primary bg-primary/10' : 'hover:border-primary/50'}`}
                                >
                                    <div className="font-mono font-semibold text-primary mb-1">ID: {user.telegramId}</div>
                                    <div className="text-muted-foreground truncate">"{user.text}"</div>
                                    <div className="text-[10px] text-muted-foreground mt-2 opacity-60">
                                        {new Date(user.date).toLocaleString('ru-RU')}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Step 2: Search Driver */}
                        {selectedTgId && (
                            <div className="animate-in slide-in-from-top-4 duration-300">
                                <h3 className="text-sm font-semibold mb-3 tracking-wide mt-6 border-t pt-6">
                                    2. Найдите водителя в CRM:
                                </h3>
                                <div className="flex gap-2 mb-4">
                                    <Input
                                        placeholder="Поиск по ФИО или телефону..."
                                        value={searchQuery}
                                        onChange={e => setSearchQuery(e.target.value)}
                                        onKeyDown={e => e.key === 'Enter' && handleSearch()}
                                        className="bg-secondary/30"
                                    />
                                    <Button onClick={handleSearch} variant="secondary">
                                        <Search className="w-4 h-4 mr-2" /> Поиск
                                    </Button>
                                </div>

                                {/* Step 3: Link Results */}
                                {drivers.length > 0 && (
                                    <div className="space-y-2 mt-4">
                                        {drivers.map(driver => (
                                            <div key={driver.id} className="flex items-center justify-between p-3 border rounded-lg bg-card hover:bg-muted/30 transition-colors">
                                                <div>
                                                    <div className="font-semibold">{driver.first_name} {driver.last_name}</div>
                                                    <div className="text-xs text-muted-foreground font-mono mt-1">
                                                        {driver.phones?.[0] || 'Нет телефона'}
                                                    </div>
                                                </div>
                                                <Button
                                                    size="sm"
                                                    onClick={() => handleLink(driver.id, `${driver.first_name} ${driver.last_name}`)}
                                                    disabled={linking}
                                                >
                                                    <Link2 className="w-4 h-4 mr-2" />
                                                    Связать
                                                </Button>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {error && <div className="text-red-500 text-sm mt-4 p-2 bg-red-50 rounded border border-red-100">{error}</div>}
                                {success && <div className="text-green-600 text-sm mt-4 p-2 bg-green-50 rounded border border-green-100">{success}</div>}
                            </div>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
