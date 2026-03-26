"use client"

import { useState, useEffect } from 'react'
import { CheckCircle2, QrCode, LogOut, Loader2, Send, Plus, Star, Edit2 } from 'lucide-react'
import { getTelegramAuthQR, checkTelegramAuthStatus, disconnectTelegram, submitTelegram2FAPassword, updateTelegramConnectionSettings } from '../../../tg-actions'

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export default function TelegramLoginClient({ initialConnections = [] }: { initialConnections: any[] }) {
    const [isAddingNew, setIsAddingNew] = useState(initialConnections.length === 0)
    
    const hasExisting = initialConnections.length > 0
    
    // Auth Form State
    const [apiId, setApiId] = useState(hasExisting ? initialConnections[0].apiId.toString() : '')
    const [apiHash, setApiHash] = useState(hasExisting ? initialConnections[0].apiHash : '')
    const [qrUrl, setQrUrl] = useState<string | null>(null)
    const [loginId, setLoginId] = useState<string | null>(null)
    const [status, setStatus] = useState<string>('idle')
    const [loading, setLoading] = useState(false)
    const [password, setPassword] = useState('')
    const [authError, setAuthError] = useState<string | null>(null)

    // Edit Connection State
    const [editingId, setEditingId] = useState<string | null>(null)
    const [editName, setEditName] = useState('')

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setStatus('generating_qr')
        try {
            const { loginId, qrUrl } = await getTelegramAuthQR(Number(apiId), apiHash)
            setQrUrl(qrUrl)
            setLoginId(loginId)
            setStatus('awaiting_scan')
        } catch (err) {
            setStatus('error')
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        let interval: NodeJS.Timeout
        if (status === 'awaiting_scan' && loginId) {
            interval = setInterval(async () => {
                try {
                    const { status: newStatus, qrUrl: newQrUrl } = await checkTelegramAuthStatus(loginId, Number(apiId), apiHash)
                    
                    if (newQrUrl && newQrUrl !== qrUrl) {
                        setQrUrl(newQrUrl)
                    }

                    if (newStatus === 'success') {
                        setStatus('success')
                        clearInterval(interval)
                        window.location.reload()
                    } else if (newStatus === '2fa_required') {
                        setStatus('2fa_required')
                        clearInterval(interval)
                    } else if (newStatus === 'expired') {
                        setStatus('idle')
                        setQrUrl(null)
                        clearInterval(interval)
                    } else if (newStatus === 'error') {
                        setStatus('error')
                        clearInterval(interval)
                    }
                } catch (pollErr) {
                    console.error('[TG-CLIENT] Polling error:', pollErr)
                }
            }, 3000)
        }
        return () => clearInterval(interval)
    }, [status, loginId, apiId, apiHash])

    const handle2FASubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!loginId || !password) return
        setLoading(true)
        setAuthError(null)
        try {
            const result = await submitTelegram2FAPassword(loginId, password)
            if (result.success) {
                setStatus('awaiting_scan') // Return to polling state to trigger reload
            } else {
                setAuthError(result.error || 'Invalid password')
            }
        } catch (err: any) {
            setAuthError('Failed to submit password')
        } finally {
            setLoading(false)
        }
    }

    const handleDisconnect = async (id: string) => {
        if (confirm('Отключить этот аккаунт Telegram?')) {
            await disconnectTelegram(id)
            window.location.reload() // Reload to reflect changes
        }
    }

    const handleSaveName = async (id: string, isDefault: boolean) => {
        if (!editName.trim()) return
        await updateTelegramConnectionSettings(id, editName.trim(), isDefault)
        setEditingId(null)
        window.location.reload()
    }

    const handleSetDefault = async (conn: any) => {
        if (conn.isDefault) return
        await updateTelegramConnectionSettings(conn.id, conn.name || 'Account', true)
        window.location.reload()
    }

    return (
        <div className="flex flex-col gap-8">
            {initialConnections.length > 0 && (
                <div className="animate-in fade-in duration-500">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-xl font-bold text-foreground">Подключенные аккаунты ({initialConnections.length})</h2>
                        {!isAddingNew && (
                            <Button variant="outline" size="sm" onClick={() => setIsAddingNew(true)}>
                                <Plus size={16} className="mr-2" /> Добавить аккаунт
                            </Button>
                        )}
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {initialConnections.map(conn => (
                            <div key={conn.id} className={`relative flex flex-col rounded-2xl border bg-card p-5 shadow-sm transition-all ${conn.isDefault ? 'border-primary ring-1 ring-primary/20' : ''}`}>
                                {conn.isDefault && (
                                    <div className="absolute -top-3 -right-3 rounded-full bg-primary text-primary-foreground p-1.5 shadow-sm" title="Аккаунт по умолчанию">
                                        <Star size={14} fill="currentColor" />
                                    </div>
                                )}
                                
                                <div className="flex items-start justify-between mb-4">
                                    <div className="flex items-center gap-3">
                                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 text-green-600">
                                            <CheckCircle2 size={24} />
                                        </div>
                                        <div>
                                            {editingId === conn.id ? (
                                                <div className="flex items-center gap-2">
                                                    <Input 
                                                        value={editName} 
                                                        onChange={e => setEditName(e.target.value)}
                                                        className="h-7 text-sm py-0 w-32"
                                                        autoFocus
                                                    />
                                                    <Button size="sm" className="h-7 text-xs px-2" onClick={() => handleSaveName(conn.id, conn.isDefault)}>Сохранить</Button>
                                                </div>
                                            ) : (
                                                <div className="flex items-center gap-2">
                                                    <div className="font-semibold text-foreground truncate max-w-[120px]">{conn.name || 'Аккаунт без имени'}</div>
                                                    <button onClick={() => { setEditingId(conn.id); setEditName(conn.name || ''); }} className="text-muted-foreground hover:text-foreground">
                                                        <Edit2 size={12} />
                                                    </button>
                                                </div>
                                            )}
                                            <div className="text-xs text-muted-foreground">{conn.phoneNumber || `ID: ${conn.id}`}</div>
                                        </div>
                                    </div>
                                </div>
                                
                                <div className="mt-auto pt-4 flex flex-col gap-2">
                                    {!conn.isDefault && (
                                        <Button variant="secondary" size="sm" className="w-full text-xs" onClick={() => handleSetDefault(conn)}>
                                            Сделать основным
                                        </Button>
                                    )}
                                    <Button variant="ghost" size="sm" className="w-full text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => handleDisconnect(conn.id)}>
                                        <LogOut size={14} className="mr-2" /> Отключить
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {isAddingNew && (
                <div className="grid grid-cols-1 items-start gap-8 md:grid-cols-2 animate-in fade-in duration-500 bg-secondary/20 p-6 rounded-3xl border border-border/50">
                    <div className="rounded-2xl border bg-card p-6 shadow-sm">
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="flex items-center gap-3 text-xl font-bold text-foreground">
                                <div className="rounded-lg bg-blue-100 p-2 text-blue-600">
                                    <Send size={20} />
                                </div>
                                Подключение
                            </h2>
                            {initialConnections.length > 0 && (
                                <Button variant="ghost" size="sm" onClick={() => setIsAddingNew(false)}>Отмена</Button>
                            )}
                        </div>
                        
                        <form onSubmit={handleLogin} className="flex flex-col gap-5">
                            {!hasExisting && (
                                <>
                                    <div>
                                        <label className="mb-2 block text-xs font-medium text-muted-foreground uppercase">App API ID</label>
                                        <Input
                                            placeholder="напр. 1234567"
                                            value={apiId}
                                            onChange={(e) => setApiId(e.target.value)}
                                            required
                                            className="bg-secondary/50"
                                        />
                                    </div>
                                    <div>
                                        <label className="mb-2 block text-xs font-medium text-muted-foreground uppercase">App API Hash</label>
                                        <Input
                                            placeholder="напр. ab12cd34..."
                                            value={apiHash}
                                            onChange={(e) => setApiHash(e.target.value)}
                                            required
                                            className="bg-secondary/50"
                                        />
                                    </div>
                                </>
                            )}
                            <div className={hasExisting ? "" : "mt-4"}>
                                <Button
                                    type="submit"
                                    disabled={loading || status === 'awaiting_scan'}
                                    className="w-full py-6 text-base shadow-md"
                                >
                                    {loading ? <Loader2 className="mr-2 animate-spin" /> : <QrCode size={18} className="mr-2" />}
                                    Сгенерировать QR для входа
                                </Button>
                            </div>
                        </form>
                    </div>

                    <div className="flex min-h-[400px] flex-col items-center justify-center rounded-2xl border bg-card p-8 shadow-sm">
                        {status === 'idle' && (
                            <div className="text-center">
                                <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-2xl bg-secondary text-muted-foreground">
                                    <QrCode size={40} />
                                </div>
                                <p className="text-sm text-muted-foreground">
                                    {hasExisting 
                                        ? "Нажмите кнопку слева, чтобы сгенерировать QR-код для нового аккаунта."
                                        : "Укажите API ID и Hash слева, \nчтобы сгенерировать QR-код для входа."}
                                </p>
                            </div>
                        )}

                        {status === 'generating_qr' && (
                            <div className="text-center">
                                <Loader2 className="mx-auto mb-4 animate-spin text-primary" size={48} />
                                <p className="text-sm font-medium text-muted-foreground">Связь с Telegram API...</p>
                            </div>
                        )}

                        {status === 'awaiting_scan' && qrUrl && (
                            <div className="text-center animate-in fade-in zoom-in-95 duration-500">
                                <div className="mb-6 rounded-3xl border-4 border-muted bg-white p-4 shadow-xl">
                                    <img src={qrUrl} alt="Telegram QR Login" className="h-[200px] w-[200px]" />
                                </div>
                                <h3 className="mb-2 text-xl font-bold text-foreground">Наведите сканер</h3>
                                <p className="mx-auto max-w-[240px] text-sm text-muted-foreground">
                                    Откройте Telegram → Настройки → Устройства → <b>Подключить устройство</b>
                                </p>
                            </div>
                        )}

                        {status === '2fa_required' && (
                            <div className="w-full max-w-sm text-center animate-in zoom-in-95 duration-300">
                                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-100 text-blue-600 shadow-sm">
                                    <CheckCircle2 size={32} />
                                </div>
                                <h3 className="mb-2 text-lg font-bold text-foreground">Облачный пароль</h3>
                                <p className="mb-6 text-sm text-muted-foreground">
                                    Ваш аккаунт защищен двухэтапной аутентификацией.
                                </p>

                                <form onSubmit={handle2FASubmit} className="flex flex-col gap-4">
                                    <div>
                                        <Input
                                            type="password"
                                            placeholder="Введите пароль..."
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            required
                                            className="bg-secondary/50 text-center"
                                        />
                                    </div>
                                    {authError && <p className="text-left text-xs font-medium text-destructive">{authError}</p>}
                                    <Button
                                        type="submit"
                                        disabled={loading}
                                        className="w-full py-6"
                                    >
                                        {loading ? <Loader2 className="animate-spin" size={18} /> : "Разблокировать"}
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        onClick={() => setStatus('idle')}
                                        className="mt-2 text-xs text-muted-foreground hover:text-foreground uppercase tracking-widest"
                                    >
                                        Отмена
                                    </Button>
                                </form>
                            </div>
                        )}

                        {status === 'error' && (
                            <div className="flex flex-col items-center text-center">
                                <div className="mb-4 rounded-full bg-red-100 p-3 text-red-600">
                                    <LogOut size={32} />
                                </div>
                                <p className="mb-2 text-lg font-bold text-destructive">Ошибка подключения</p>
                                <p className="mb-6 text-sm text-muted-foreground">Проверьте API ID и Hash и попробуйте снова.</p>
                                <Button
                                    variant="outline"
                                    onClick={() => setStatus('idle')}
                                >
                                    Попробовать снова
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
