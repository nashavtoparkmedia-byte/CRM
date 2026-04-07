"use client"

import { useState, useEffect } from 'react'
import { CheckCircle2, QrCode, LogOut, Loader2, Send, Plus, Star, Edit2, PauseCircle, PlayCircle, Trash2 } from 'lucide-react'
import { getTelegramAuthQR, checkTelegramAuthStatus, disconnectTelegram, submitTelegram2FAPassword, updateTelegramConnectionSettings, pauseTelegramConnection, resumeTelegramConnection, deleteConnectionMessages } from '../../../tg-actions'
import ChannelSyncBlock from "@/components/ChannelSyncBlock"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"

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

    // Pause/Resume/Delete/Disconnect dialog state
    const [pauseDialog, setPauseDialog] = useState<{ connId: string; connName: string } | null>(null)
    const [resumeDialog, setResumeDialog] = useState<{ connId: string; connName: string; bufferedCount?: number } | null>(null)
    const [deleteDialog, setDeleteDialog] = useState<{ connId: string; connName: string } | null>(null)
    const [disconnectDialog, setDisconnectDialog] = useState<{ connId: string; connName: string } | null>(null)
    const [actionLoading, setActionLoading] = useState(false)

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setStatus('generating_qr')
        try {
            const { loginId, qrUrl } = await getTelegramAuthQR(Number(apiId), apiHash)
            setQrUrl(qrUrl)
            setLoginId(loginId)
            setStatus('awaiting_scan')
        } catch (err: any) {
            setStatus('error')
            setAuthError(err?.message || 'Ошибка подключения к Telegram')
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

    const handleDisconnectConfirm = async (deleteMessages: boolean) => {
        if (!disconnectDialog) return
        setActionLoading(true)
        try {
            if (deleteMessages) {
                await deleteConnectionMessages(disconnectDialog.connId)
            }
            await disconnectTelegram(disconnectDialog.connId)
            window.location.reload()
        } finally {
            setActionLoading(false)
            setDisconnectDialog(null)
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

    const handlePauseConfirm = async (deleteMessages: boolean) => {
        if (!pauseDialog) return
        setActionLoading(true)
        try {
            await pauseTelegramConnection(pauseDialog.connId, deleteMessages)
            window.location.reload()
        } finally {
            setActionLoading(false)
            setPauseDialog(null)
        }
    }

    const handleResumeConfirm = async (catchUp: boolean) => {
        if (!resumeDialog) return
        setActionLoading(true)
        try {
            await resumeTelegramConnection(resumeDialog.connId, catchUp)
            window.location.reload()
        } finally {
            setActionLoading(false)
            setResumeDialog(null)
        }
    }

    const handleDeleteConfirm = async () => {
        if (!deleteDialog) return
        setActionLoading(true)
        try {
            await deleteConnectionMessages(deleteDialog.connId)
            window.location.reload()
        } finally {
            setActionLoading(false)
            setDeleteDialog(null)
        }
    }

    return (
        <>
        <div className="flex flex-col gap-8">
            {initialConnections.length > 0 && (
                <div className="animate-in fade-in duration-500">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-base font-semibold text-foreground">Подключенные аккаунты ({initialConnections.length})</h2>
                        {!isAddingNew && (
                            <Button variant="outline" size="sm" onClick={() => setIsAddingNew(true)}>
                                <Plus size={14} className="mr-1.5" /> Добавить аккаунт
                            </Button>
                        )}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {initialConnections.map(conn => (
                            <div key={conn.id} className="flex flex-col rounded-2xl border bg-card p-5 shadow-sm transition-all">

                                <div className="flex items-start justify-between mb-3">
                                    <div className="flex items-center gap-3">
                                        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${conn.isPaused ? 'bg-amber-100 text-amber-600' : 'bg-sky-100 text-sky-500'}`}>
                                            {conn.isPaused ? <PauseCircle size={18} /> : <CheckCircle2 size={18} />}
                                        </div>
                                        <div className="min-w-0">
                                            {editingId === conn.id ? (
                                                <div className="flex items-center gap-2">
                                                    <Input
                                                        value={editName}
                                                        onChange={e => setEditName(e.target.value)}
                                                        className="h-7 text-sm py-0 w-32"
                                                        autoFocus
                                                    />
                                                    <Button size="sm" className="h-7 text-xs px-2" onClick={() => handleSaveName(conn.id, conn.isDefault)}>Сохр.</Button>
                                                </div>
                                            ) : (
                                                <div className="flex items-center gap-1.5 flex-wrap">
                                                    <span className="font-semibold text-sm text-foreground truncate max-w-[110px]">{conn.name || 'Аккаунт'}</span>
                                                    <button onClick={() => { setEditingId(conn.id); setEditName(conn.name || ''); }} className="text-muted-foreground hover:text-foreground">
                                                        <Edit2 size={11} />
                                                    </button>
                                                    {conn.isDefault && (
                                                        <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-foreground/70">основной</span>
                                                    )}
                                                </div>
                                            )}
                                            <div className="flex items-center gap-2 mt-0.5">
                                                <span className="text-xs text-muted-foreground">{conn.phoneNumber || `ID: ${conn.id}`}</span>
                                                {conn.isPaused ? (
                                                    <span className="flex items-center gap-1 text-[11px] text-amber-600">
                                                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> На паузе
                                                    </span>
                                                ) : (
                                                    <span className="flex items-center gap-1 text-[11px] text-emerald-600">
                                                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Активен
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <ChannelSyncBlock channel="telegram" connectionId={conn.id} />

                                <div className="flex items-center justify-end gap-1 pt-3 mt-3 border-t border-dashed">
                                    {!conn.isDefault && !conn.isPaused && (
                                        <Button variant="ghost" size="sm" className="h-8 px-3 text-xs text-muted-foreground hover:bg-secondary" onClick={() => handleSetDefault(conn)}>
                                            <Star size={12} className="mr-1.5" /> Основным
                                        </Button>
                                    )}
                                    {conn.isPaused ? (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 px-3 text-xs text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700"
                                            onClick={() => setResumeDialog({ connId: conn.id, connName: conn.name || conn.phoneNumber || conn.id })}
                                        >
                                            <PlayCircle size={13} className="mr-1.5" /> Включить
                                        </Button>
                                    ) : (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 px-3 text-xs text-amber-600 hover:bg-amber-50 hover:text-amber-700"
                                            onClick={() => setPauseDialog({ connId: conn.id, connName: conn.name || conn.phoneNumber || conn.id })}
                                        >
                                            <PauseCircle size={13} className="mr-1.5" /> Пауза
                                        </Button>
                                    )}
                                    <Button variant="ghost" size="sm" className="h-8 px-3 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDisconnectDialog({ connId: conn.id, connName: conn.name || conn.phoneNumber || conn.id })}>
                                        <LogOut size={13} className="mr-1.5" /> Отключить
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {isAddingNew && (
                <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2 animate-in fade-in duration-500 bg-muted/30 p-5 rounded-2xl border">
                    <div className="rounded-2xl border bg-card p-5 shadow-sm">
                        <div className="flex justify-between items-center mb-5">
                            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                                <div className="rounded-lg bg-sky-100 p-1.5 text-sky-500">
                                    <Send size={16} />
                                </div>
                                Подключение аккаунта
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

                    <div className="flex min-h-[360px] flex-col items-center justify-center rounded-2xl border bg-card p-6 shadow-sm">
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
                                <p className="mb-4 text-sm text-muted-foreground">
                                    {authError || 'Проверьте API ID и Hash и попробуйте снова.'}
                                </p>
                                <Button
                                    variant="outline"
                                    onClick={() => { setStatus('idle'); setAuthError(null) }}
                                >
                                    Попробовать снова
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>

        {/* PAUSE DIALOG */}
        <Dialog open={!!pauseDialog} onOpenChange={() => setPauseDialog(null)}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Поставить аккаунт на паузу</DialogTitle>
                    <DialogDescription>
                        Аккаунт временно остановит обработку сообщений. Подключение останется активным.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3 py-2">
                    <Button
                        variant="outline"
                        className="w-full justify-start text-sm h-auto py-3 px-4"
                        disabled={actionLoading}
                        onClick={() => handlePauseConfirm(false)}
                    >
                        <div className="flex flex-col items-start text-left">
                            <span className="font-medium">Поставить на паузу</span>
                            <span className="text-xs text-muted-foreground mt-0.5">Сообщения сохраняются, обработка остановлена.</span>
                        </div>
                    </Button>
                    <Button
                        variant="outline"
                        className="w-full justify-start text-sm h-auto py-3 px-4 border-destructive/30 hover:bg-destructive/5"
                        disabled={actionLoading}
                        onClick={() => handlePauseConfirm(true)}
                    >
                        {actionLoading ? <Loader2 size={14} className="mr-2 animate-spin flex-shrink-0" /> : null}
                        <div className="flex flex-col items-start text-left">
                            <span className="font-medium text-destructive">Пауза и удалить сообщения</span>
                            <span className="text-xs text-muted-foreground mt-0.5">Все сообщения этого аккаунта будут удалены из CRM.</span>
                        </div>
                    </Button>
                </div>
                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => setPauseDialog(null)}>Отмена</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        {/* RESUME DIALOG */}
        <Dialog open={!!resumeDialog} onOpenChange={() => setResumeDialog(null)}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <PlayCircle size={20} className="text-green-500" />
                        Включить: {resumeDialog?.connName}
                    </DialogTitle>
                    <DialogDescription>
                        Аккаунт был на паузе. Пока он был выключен, входящие сообщения накапливались в буфере.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3 py-2">
                    <p className="text-sm text-muted-foreground">Что делать с буфером сообщений за период паузы?</p>
                    <Button
                        variant="outline"
                        className="w-full justify-start text-sm h-auto py-3 px-4 border-green-300 hover:bg-green-50"
                        disabled={actionLoading}
                        onClick={() => handleResumeConfirm(true)}
                    >
                        {actionLoading ? <Loader2 size={14} className="mr-2 animate-spin" /> : null}
                        <div className="flex flex-col items-start text-left">
                            <span className="font-medium text-green-700">Пробросить в CRM</span>
                            <span className="text-xs text-muted-foreground mt-0.5">Все накопленные сообщения появятся в /messages</span>
                        </div>
                    </Button>
                    <Button
                        variant="outline"
                        className="w-full justify-start text-sm h-auto py-3 px-4"
                        disabled={actionLoading}
                        onClick={() => handleResumeConfirm(false)}
                    >
                        <div className="flex flex-col items-start text-left">
                            <span className="font-medium">Начать с этого места</span>
                            <span className="text-xs text-muted-foreground mt-0.5">Буфер удаляется, новые сообщения появляются в CRM как обычно</span>
                        </div>
                    </Button>
                </div>
                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => setResumeDialog(null)}>Отмена</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        {/* DELETE MESSAGES DIALOG */}
        <Dialog open={!!deleteDialog} onOpenChange={() => setDeleteDialog(null)}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Trash2 size={20} className="text-destructive" />
                        Удалить сообщения: {deleteDialog?.connName}
                    </DialogTitle>
                    <DialogDescription>
                        Все сообщения и чаты этого аккаунта будут удалены из раздела /messages.
                        В Telegram они останутся без изменений.
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter className="gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setDeleteDialog(null)}>Отмена</Button>
                    <Button
                        variant="destructive"
                        size="sm"
                        disabled={actionLoading}
                        onClick={handleDeleteConfirm}
                    >
                        {actionLoading ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Trash2 size={14} className="mr-2" />}
                        Удалить
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        {/* DISCONNECT DIALOG */}
        <Dialog open={!!disconnectDialog} onOpenChange={() => setDisconnectDialog(null)}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Отключить аккаунт</DialogTitle>
                    <DialogDescription>
                        Аккаунт будет полностью отключён. Для повторного подключения потребуется снова отсканировать QR-код.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3 py-2">
                    <Button
                        variant="outline"
                        className="w-full justify-start text-sm h-auto py-3 px-4"
                        disabled={actionLoading}
                        onClick={() => handleDisconnectConfirm(false)}
                    >
                        <div className="flex flex-col items-start text-left">
                            <span className="font-medium">Просто отключить</span>
                            <span className="text-xs text-muted-foreground mt-0.5">Аккаунт отключится, сообщения останутся.</span>
                        </div>
                    </Button>
                    <Button
                        variant="outline"
                        className="w-full justify-start text-sm h-auto py-3 px-4 border-destructive/30 hover:bg-destructive/5"
                        disabled={actionLoading}
                        onClick={() => handleDisconnectConfirm(true)}
                    >
                        {actionLoading ? <Loader2 size={14} className="mr-2 animate-spin flex-shrink-0" /> : null}
                        <div className="flex flex-col items-start text-left">
                            <span className="font-medium text-destructive">Отключить и удалить сообщения</span>
                            <span className="text-xs text-muted-foreground mt-0.5">Аккаунт отключится, все сообщения будут удалены из CRM.</span>
                        </div>
                    </Button>
                </div>
                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => setDisconnectDialog(null)}>Отмена</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
        </>
    )
}
