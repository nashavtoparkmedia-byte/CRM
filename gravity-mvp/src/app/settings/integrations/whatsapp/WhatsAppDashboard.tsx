'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Trash2, Loader2, MessageCircle, Wifi, WifiOff, RefreshCw, AlertTriangle, PauseCircle, PlayCircle, LogOut, Pencil, Check, X } from 'lucide-react'
import { createWhatsAppConnection, getWhatsAppConnections, getWhatsAppStatus, disconnectWhatsApp, refreshWhatsAppQR, pauseWhatsAppConnection, resumeWhatsAppConnection, deleteWhatsAppMessages, forceResetWhatsAppSession, renameWhatsAppConnection } from './whatsapp-actions'
import ChannelSyncBlock from "@/components/ChannelSyncBlock"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"

type WaConnection = {
    id: string
    name: string | null
    status: string
    phoneNumber: string | null
    sessionData: string | null
    createdAt?: string | Date
    // Derived fields from getActualStatus — may be undefined for stale connections
    actualState?: string
    actualLabel?: string
    canRetry?: boolean
    canForceQR?: boolean
    canForceReset?: boolean
    lastError?: string | null
}

// PR7.14: маскировка телефона +79221855750 → +7922•••5750.
// Используется для secondary line в header карточки.
function maskPhoneInCard(raw: string | null | undefined): string | null {
    if (!raw) return null
    const digits = String(raw).replace(/\D/g, '')
    if (digits.length < 7) return raw ? `+${raw}` : null
    return `+${digits.slice(0, 4)}•••${digits.slice(-4)}`
}

// PR7.14: smart-имя для карточки и нового канала.
// Приоритет: custom name → masked phone → дата создания.
// Legacy «WhatsApp Account» считается отсутствием имени.
const LEGACY_DEFAULT_NAMES = new Set([
    'WhatsApp Account', 'WhatsApp Аккаунт', 'whatsapp account',
])

function deriveDisplayName(conn: WaConnection): { primary: string; isPlaceholder: boolean } {
    const raw = conn.name?.trim() ?? ''
    if (raw.length > 0 && !LEGACY_DEFAULT_NAMES.has(raw)) {
        return { primary: raw, isPlaceholder: false }
    }
    const phone = maskPhoneInCard(conn.phoneNumber)
    if (phone) return { primary: phone, isPlaceholder: false }
    if (conn.createdAt) {
        const d = new Date(conn.createdAt)
        if (!isNaN(d.getTime())) {
            return { primary: `Подключение от ${d.toLocaleDateString('ru')}`, isPlaceholder: true }
        }
    }
    return { primary: 'Новое подключение', isPlaceholder: true }
}

function StatusDot({ status }: { status: string }) {
    const map: Record<string, { label: string; dot: string; text: string }> = {
        idle:          { label: 'Ожидание',       dot: 'bg-gray-400',    text: 'text-muted-foreground' },
        initializing:  { label: 'Подключение...', dot: 'bg-blue-400',    text: 'text-blue-600' },
        qr:            { label: 'Сканируйте QR',  dot: 'bg-amber-400',   text: 'text-amber-600' },
        qr_required:   { label: 'Сканируйте QR',  dot: 'bg-amber-400',   text: 'text-amber-600' },
        qr_expired:    { label: 'QR Истек',       dot: 'bg-red-500',     text: 'text-destructive' },
        authenticated: { label: 'Авторизация...', dot: 'bg-blue-400',    text: 'text-blue-600' },
        ready:         { label: 'Подключено',     dot: 'bg-emerald-500', text: 'text-emerald-600' },
        degraded:      { label: 'Нестабильно',    dot: 'bg-yellow-500',  text: 'text-yellow-600' },
        reconnecting:  { label: 'Переподключаемся...', dot: 'bg-yellow-500', text: 'text-yellow-600' },
        disconnected:  { label: 'Отключено',      dot: 'bg-red-500',     text: 'text-destructive' },
        auth_failed:   { label: 'Требуется QR',   dot: 'bg-red-500',     text: 'text-destructive' },
        broken:        { label: 'Ошибка запуска', dot: 'bg-red-500',     text: 'text-destructive' },
        error:         { label: 'Ошибка',         dot: 'bg-red-500',     text: 'text-destructive' },
    }
    const s = map[status] || { label: status, dot: 'bg-gray-400', text: 'text-muted-foreground' }
    return (
        <span className={`flex items-center gap-1 text-[11px] ${s.text}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
            {s.label}
        </span>
    )
}

function ConnectionCard({ conn, onRefresh }: { conn: WaConnection; onRefresh: () => void }) {
    const [isClient, setIsClient] = useState(false)
    const [loading, setLoading] = useState(false)
    // liveStatus uses actualState from backend (source of truth) — falls back to conn.status for legacy
    const [liveStatus, setLiveStatus] = useState(conn.actualState || conn.status)
    const [liveLastError, setLiveLastError] = useState<string | null>(conn.lastError || null)
    const [liveCanForceReset, setLiveCanForceReset] = useState(conn.canForceReset || false)
    const [livePaused, setLivePaused] = useState((conn as any).isPaused ?? false)
    const [liveQr, setLiveQr] = useState<string | null>(null)
    const pollingRef = useRef<NodeJS.Timeout | null>(null)
    const [pauseDialog, setPauseDialog] = useState(false)
    const [resumeDialog, setResumeDialog] = useState(false)
    const [syncKey, setSyncKey] = useState(0)
    const [disconnectDialog, setDisconnectDialog] = useState(false)
    // PR7.14: inline rename state. Активируется кликом на pencil-икoнку
    // рядом с именем — открывается inline-input, без модала.
    const [editingName, setEditingName] = useState(false)
    const [nameDraft, setNameDraft] = useState(conn.name ?? '')
    const [renaming, setRenaming] = useState(false)
    const nameInputRef = useRef<HTMLInputElement | null>(null)

    useEffect(() => {
        setIsClient(true)
    }, [])

    useEffect(() => {
        setLiveStatus(conn.actualState || conn.status)
        setLiveLastError(conn.lastError || null)
        setLiveCanForceReset(conn.canForceReset || false)
        if ((conn.actualState === 'qr_required' || conn.status === 'qr') && conn.sessionData?.startsWith('data:')) {
            setLiveQr(conn.sessionData)
        }
    }, [conn])

    useEffect(() => {
        if (!isClient) return
        // Poll while transitioning; also poll for degraded/reconnecting/broken so recovery shows up.
        // broken must be polled — recoverable via auto-reconnect (Baileys code 515 is common after first auth).
        const shouldPoll = ['idle', 'qr', 'qr_required', 'qr_expired', 'authenticated', 'initializing', 'degraded', 'reconnecting', 'broken'].includes(liveStatus)
        if (shouldPoll) {
            pollingRef.current = setInterval(async () => {
                const fresh = await getWhatsAppStatus(conn.id)
                if (!fresh) return
                const actual = (fresh as any).actualState || fresh.status
                setLiveStatus(actual)
                setLiveLastError((fresh as any).lastError || null)
                setLiveCanForceReset((fresh as any).canForceReset || false)
                if (typeof (fresh as any).isPaused === 'boolean') {
                    setLivePaused((fresh as any).isPaused)
                }
                if ((actual === 'qr_required' || actual === 'qr') && fresh.sessionData?.startsWith('data:')) {
                    setLiveQr(fresh.sessionData)
                }
                if (actual === 'ready') {
                    if (pollingRef.current) clearInterval(pollingRef.current)
                    onRefresh()
                }
            }, 3000)
        } else {
            if (pollingRef.current) clearInterval(pollingRef.current)
        }
        return () => { if (pollingRef.current) clearInterval(pollingRef.current) }
    }, [liveStatus, conn.id, onRefresh, isClient])

    const handleForceReset = async () => {
        if (!confirm('Пересоздать сессию? Потребуется снова отсканировать QR-код.')) return
        setLoading(true)
        try {
            await forceResetWhatsAppSession(conn.id)
            setLiveStatus('idle')
            setLiveLastError(null)
            onRefresh()
        } catch (err) {
            console.error('[WA] Force reset failed:', err)
        } finally {
            setLoading(false)
        }
    }

    const handlePauseConfirm = async (deleteMessages: boolean) => {
        setLoading(true)
        try {
            await pauseWhatsAppConnection(conn.id, deleteMessages)
            setLivePaused(true)
            setPauseDialog(false)
            if (deleteMessages) setSyncKey(k => k + 1)
            onRefresh()
        } catch (err) {
            console.error('[WA] Pause failed:', err)
        } finally {
            setLoading(false)
        }
    }

    const handleResumeConfirm = async (catchUp: boolean) => {
        setLoading(true)
        try {
            await resumeWhatsAppConnection(conn.id, catchUp)
            setLivePaused(false)
            setResumeDialog(false)
            onRefresh()
        } catch (err) {
            console.error('[WA] Resume failed:', err)
        } finally {
            setLoading(false)
        }
    }

    const handleRenameStart = () => {
        // Pre-populate с тем что реально в БД, не с derived display.
        // Если name был legacy default или null — input пустой.
        const raw = conn.name?.trim() ?? ''
        setNameDraft(LEGACY_DEFAULT_NAMES.has(raw) ? '' : raw)
        setEditingName(true)
        setTimeout(() => nameInputRef.current?.focus(), 30)
    }
    const handleRenameCancel = () => {
        setEditingName(false)
        setNameDraft(conn.name ?? '')
    }
    const handleRenameSave = async () => {
        if (renaming) return
        setRenaming(true)
        try {
            await renameWhatsAppConnection(conn.id, nameDraft)
            setEditingName(false)
            onRefresh()
        } catch (err) {
            console.error('[WA] Rename failed:', err)
        } finally {
            setRenaming(false)
        }
    }

    const handleDisconnectConfirm = async (deleteMessages: boolean) => {
        setLoading(true)
        try {
            if (deleteMessages) {
                await deleteWhatsAppMessages(conn.id)
                setSyncKey(k => k + 1)
            }
            // Wipe auth only when user also deletes messages — total reset scenario.
            // "Просто отключить" keeps auth so reconnect doesn't require QR.
            await disconnectWhatsApp(conn.id, deleteMessages)
            setLiveStatus('idle')
            setDisconnectDialog(false)
            onRefresh()
        } catch (err) {
            console.error('[WA] Disconnect failed:', err)
        } finally {
            setLoading(false)
        }
    }

    if (!isClient) {
        return <div className="h-[220px] animate-pulse rounded-2xl border bg-muted/50 p-5" />
    }

    // PR7.14: derived display name. Если custom не задано — fallback
    // на phone/дата, без литерала «WhatsApp Account».
    const display = deriveDisplayName(conn)
    const maskedPhone = maskPhoneInCard(conn.phoneNumber)
    // Phone показываем как secondary line ТОЛЬКО если оно отличается
    // от primary (т.е. primary = custom name, не сам phone).
    const showPhoneSecondary = maskedPhone && display.primary !== maskedPhone

    return (
        <div className="flex flex-col gap-3 rounded-2xl border bg-card p-5 shadow-sm transition-all">
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-600">
                        <MessageCircle size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                        {/* PR7.14: имя — primary, c inline-rename. Если
                            редактируем — input + save/cancel. Если нет —
                            text + pencil-icon (виден на hover). */}
                        {editingName ? (
                            <div className="flex items-center gap-1.5">
                                <input
                                    ref={nameInputRef}
                                    type="text"
                                    value={nameDraft}
                                    maxLength={80}
                                    placeholder="Например: Поддержка водителей"
                                    onChange={e => setNameDraft(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') handleRenameSave()
                                        if (e.key === 'Escape') handleRenameCancel()
                                    }}
                                    disabled={renaming}
                                    className="flex-1 min-w-0 h-7 px-2 text-sm font-semibold border border-input rounded-md outline-none focus:border-primary bg-background"
                                />
                                <button
                                    type="button"
                                    onClick={handleRenameSave}
                                    disabled={renaming}
                                    title="Сохранить"
                                    className="h-7 w-7 inline-flex items-center justify-center text-emerald-600 hover:bg-emerald-50 rounded-md disabled:opacity-50"
                                >
                                    {renaming ? <Loader2 size={13} className="animate-spin" /> : <Check size={14} />}
                                </button>
                                <button
                                    type="button"
                                    onClick={handleRenameCancel}
                                    disabled={renaming}
                                    title="Отмена"
                                    className="h-7 w-7 inline-flex items-center justify-center text-muted-foreground hover:bg-muted rounded-md disabled:opacity-50"
                                >
                                    <X size={14} />
                                </button>
                            </div>
                        ) : (
                            <div className="group/name flex items-center gap-1.5">
                                <span
                                    className={`font-semibold text-sm truncate ${display.isPlaceholder ? 'text-muted-foreground italic' : 'text-foreground'}`}
                                    title={display.isPlaceholder ? 'Имя не задано — нажмите карандашик чтобы задать' : conn.name ?? undefined}
                                >
                                    {display.primary}
                                </span>
                                <button
                                    type="button"
                                    onClick={handleRenameStart}
                                    disabled={loading}
                                    title="Переименовать аккаунт"
                                    className="h-6 w-6 inline-flex items-center justify-center text-muted-foreground/60 hover:text-primary hover:bg-primary/10 rounded-md opacity-0 group-hover/name:opacity-100 transition-opacity"
                                >
                                    <Pencil size={11} />
                                </button>
                            </div>
                        )}
                        {/* PR7.14: secondary line — phone + status + paused */}
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            {showPhoneSecondary && (
                                <span className="text-xs text-muted-foreground">{maskedPhone}</span>
                            )}
                            <StatusDot status={liveStatus} />
                            {livePaused && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                                    <PauseCircle size={11} /> На паузе
                                </span>
                            )}
                        </div>
                        {/* PR7.14: placeholder hint — подсказка «задайте имя»
                            видна только когда display = placeholder И
                            пользователь не редактирует. Помогает понять
                            «откуда у меня два одинаковых ватсапа». */}
                        {display.isPlaceholder && !editingName && (
                            <button
                                type="button"
                                onClick={handleRenameStart}
                                className="mt-1 text-[11px] text-primary hover:underline inline-flex items-center gap-1"
                            >
                                <Pencil size={10} /> Задайте имя — будет проще отличать аккаунты
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* QR Display */}
            {(liveStatus === 'qr' || liveStatus === 'qr_required' || liveStatus === 'qr_expired') && (
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
            {(liveStatus === 'authenticated' || liveStatus === 'initializing') && (
                <div className="flex items-center gap-3 py-4 text-blue-600">
                    <Loader2 size={18} className="animate-spin" />
                    <span className="text-sm font-medium">
                        {liveStatus === 'initializing' ? 'Подключение...' : 'Завершение аутентификации...'}
                    </span>
                </div>
            )}

            {/* Reconnecting */}
            {liveStatus === 'reconnecting' && (
                <div className="flex items-center gap-3 py-4 text-yellow-600">
                    <Loader2 size={18} className="animate-spin" />
                    <span className="text-sm font-medium">Переподключаемся...</span>
                </div>
            )}

            {/* Degraded — connection unstable */}
            {liveStatus === 'degraded' && (
                <div className="flex flex-col gap-2 py-4">
                    <div className="flex items-center gap-3 text-yellow-600">
                        <AlertTriangle size={18} />
                        <span className="text-sm font-medium">Связь нестабильна — нет сигнала от WhatsApp {'>'} 5 минут</span>
                    </div>
                    <Button onClick={handleForceReset} variant="outline" size="sm" disabled={loading} className="self-start">
                        <RefreshCw size={14} className="mr-2" /> Пересоздать сессию
                    </Button>
                </div>
            )}

            {/* Broken — init crashed or runtime dead */}
            {liveStatus === 'broken' && (
                <div className="flex flex-col gap-2 py-4">
                    <div className="flex items-center gap-3 text-red-600">
                        <AlertTriangle size={18} />
                        <span className="text-sm font-medium">Ошибка запуска WhatsApp-клиента</span>
                    </div>
                    {liveLastError && (
                        <div className="text-xs text-muted-foreground break-all">{liveLastError}</div>
                    )}
                    <Button onClick={handleForceReset} variant="outline" size="sm" disabled={loading} className="self-start">
                        <RefreshCw size={14} className="mr-2" /> Пересоздать сессию
                    </Button>
                </div>
            )}

            {/* Auth failed — need fresh QR */}
            {liveStatus === 'auth_failed' && (
                <div className="flex flex-col gap-2 py-4">
                    <div className="flex items-center gap-3 text-red-600">
                        <AlertTriangle size={18} />
                        <span className="text-sm font-medium">Требуется повторная авторизация</span>
                    </div>
                    <Button onClick={handleForceReset} variant="outline" size="sm" disabled={loading} className="self-start">
                        <RefreshCw size={14} className="mr-2" /> Сбросить и отсканировать QR
                    </Button>
                </div>
            )}

            {/* Connected (or Paused) */}
            {liveStatus === 'ready' && !livePaused && (
                <div className="flex items-center gap-3 py-4 text-green-600">
                    <CheckCircle2 size={20} />
                    <span className="text-sm font-medium">Аккаунт подключен и готов к работе</span>
                </div>
            )}
            {liveStatus === 'ready' && livePaused && (
                <div className="flex items-center gap-3 py-4 text-amber-600">
                    <PauseCircle size={20} />
                    <span className="text-sm font-medium">Аккаунт на паузе — входящие буферизуются</span>
                </div>
            )}

            {/* Warning */}
            {liveStatus === 'ready' && (
                <p className="text-[11px] text-muted-foreground">
                    Массовые рассылки могут привести к блокировке аккаунта WhatsApp.
                </p>
            )}

            {/* История сообщений */}
            {liveStatus === 'ready' && (
                <ChannelSyncBlock key={syncKey} channel="whatsapp" connectionId={conn.id} />
            )}

            {/* Actions */}
            {liveStatus === 'ready' && (
                <div className="flex items-center justify-end gap-1 pt-3 mt-auto border-t border-dashed">
                    {livePaused ? (
                        <Button variant="ghost" size="sm" className="h-[32px] px-3 text-xs cursor-pointer text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700" onClick={() => setResumeDialog(true)} disabled={loading}>
                            <PlayCircle size={13} className="mr-1.5" /> Включить
                        </Button>
                    ) : (
                        <Button variant="ghost" size="sm" className="h-[32px] px-3 text-xs cursor-pointer text-amber-600 hover:bg-amber-50 hover:text-amber-700" onClick={() => setPauseDialog(true)} disabled={loading}>
                            <PauseCircle size={13} className="mr-1.5" /> Пауза
                        </Button>
                    )}
                    <Button variant="ghost" size="sm" className="h-[32px] px-3 text-xs cursor-pointer text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDisconnectDialog(true)} disabled={loading}>
                        <LogOut size={13} className="mr-1.5" /> Отключить
                    </Button>
                </div>
            )}
            {(liveStatus === 'idle' || liveStatus === 'disconnected' || liveStatus === 'error') && (
                <div className="flex items-center justify-end pt-3 mt-auto border-t border-dashed">
                    <Button size="sm" onClick={async () => { setLoading(true); await refreshWhatsAppQR(conn.id); onRefresh(); setLoading(false) }} disabled={loading} className="h-[32px] px-3 text-xs cursor-pointer">
                        {loading ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <Wifi size={13} className="mr-1.5" />} Переподключить
                    </Button>
                </div>
            )}

            {/* PAUSE DIALOG */}
            <Dialog open={pauseDialog} onOpenChange={setPauseDialog}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Поставить аккаунт на паузу</DialogTitle>
                        <DialogDescription>Аккаунт временно остановит обработку сообщений. Подключение останется активным.</DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-3 py-2">
                        <Button variant="outline" className="w-full justify-start text-sm h-auto py-3 px-4" disabled={loading} onClick={() => handlePauseConfirm(false)}>
                            <div className="flex flex-col items-start text-left">
                                <span className="font-medium">Поставить на паузу</span>
                                <span className="text-xs text-muted-foreground mt-0.5">Сообщения сохраняются, обработка остановлена.</span>
                            </div>
                        </Button>
                        <Button variant="outline" className="w-full justify-start text-sm h-auto py-3 px-4 border-destructive/30 hover:bg-destructive/5" disabled={loading} onClick={() => handlePauseConfirm(true)}>
                            {loading ? <Loader2 size={14} className="mr-2 animate-spin flex-shrink-0" /> : null}
                            <div className="flex flex-col items-start text-left">
                                <span className="font-medium text-destructive">Пауза и удалить сообщения</span>
                                <span className="text-xs text-muted-foreground mt-0.5">Все сообщения этого аккаунта будут удалены из CRM.</span>
                            </div>
                        </Button>
                    </div>
                    <DialogFooter><Button variant="ghost" size="sm" onClick={() => setPauseDialog(false)}>Отмена</Button></DialogFooter>
                </DialogContent>
            </Dialog>

            {/* RESUME DIALOG */}
            <Dialog open={resumeDialog} onOpenChange={setResumeDialog}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Включить аккаунт</DialogTitle>
                        <DialogDescription>Аккаунт был на паузе. Что делать с накопленными сообщениями?</DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-3 py-2">
                        <Button variant="outline" className="w-full justify-start text-sm h-auto py-3 px-4 border-green-300 hover:bg-green-50" disabled={loading} onClick={() => handleResumeConfirm(true)}>
                            <div className="flex flex-col items-start text-left">
                                <span className="font-medium text-green-700">Пробросить в CRM</span>
                                <span className="text-xs text-muted-foreground mt-0.5">Все накопленные сообщения появятся в /messages.</span>
                            </div>
                        </Button>
                        <Button variant="outline" className="w-full justify-start text-sm h-auto py-3 px-4" disabled={loading} onClick={() => handleResumeConfirm(false)}>
                            <div className="flex flex-col items-start text-left">
                                <span className="font-medium">Начать с этого места</span>
                                <span className="text-xs text-muted-foreground mt-0.5">Буфер удаляется, новые сообщения идут в CRM как обычно.</span>
                            </div>
                        </Button>
                    </div>
                    <DialogFooter><Button variant="ghost" size="sm" onClick={() => setResumeDialog(false)}>Отмена</Button></DialogFooter>
                </DialogContent>
            </Dialog>

            {/* DISCONNECT DIALOG */}
            <Dialog open={disconnectDialog} onOpenChange={setDisconnectDialog}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Отключить аккаунт</DialogTitle>
                        <DialogDescription>Выберите сценарий отключения. При удалении сообщений потребуется заново отсканировать QR-код для подключения.</DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-3 py-2">
                        <Button variant="outline" className="w-full justify-start text-sm h-auto py-3 px-4" disabled={loading} onClick={() => handleDisconnectConfirm(false)}>
                            <div className="flex flex-col items-start text-left">
                                <span className="font-medium">Просто отключить</span>
                                <span className="text-xs text-muted-foreground mt-0.5">Аккаунт отключится, сообщения останутся.</span>
                            </div>
                        </Button>
                        <Button variant="outline" className="w-full justify-start text-sm h-auto py-3 px-4 border-destructive/30 hover:bg-destructive/5" disabled={loading} onClick={() => handleDisconnectConfirm(true)}>
                            {loading ? <Loader2 size={14} className="mr-2 animate-spin flex-shrink-0" /> : null}
                            <div className="flex flex-col items-start text-left">
                                <span className="font-medium text-destructive">Отключить и удалить сообщения</span>
                                <span className="text-xs text-muted-foreground mt-0.5">Аккаунт отключится, все сообщения будут удалены из CRM.</span>
                            </div>
                        </Button>
                    </div>
                    <DialogFooter><Button variant="ghost" size="sm" onClick={() => setDisconnectDialog(false)}>Отмена</Button></DialogFooter>
                </DialogContent>
            </Dialog>
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
        // Guard: don't create if there's already a pending QR connection
        const pendingStatuses = ['idle', 'qr', 'qr_expired', 'authenticated']
        const hasPending = connections.some(c => pendingStatuses.includes(c.status))
        if (hasPending) return
        setAdding(true)
        await createWhatsAppConnection()
        await refresh()
        setAdding(false)
    }

    const hasPendingConnection = connections.some(c => ['idle', 'qr', 'qr_expired', 'authenticated'].includes(c.status))

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
            <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-foreground">Подключенные аккаунты ({connections.length})</h2>
                <Button onClick={handleAdd} disabled={adding || hasPendingConnection} size="sm" variant="outline" title={hasPendingConnection ? 'Дождитесь завершения текущего подключения' : undefined}>
                    {adding ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <MessageCircle size={14} className="mr-1.5" />}
                    Добавить аккаунт
                </Button>
            </div>

            {connections.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed p-10 text-center bg-card">
                    <div className="rounded-full bg-secondary p-3 mb-3">
                        <MessageCircle size={24} className="text-muted-foreground" />
                    </div>
                    <h3 className="mb-1 text-base font-semibold text-foreground">Нет подключенных аккаунтов</h3>
                    <p className="mb-5 max-w-sm text-sm text-muted-foreground">
                        Добавьте первый аккаунт WhatsApp, отсканировав QR-код в приложении телефона.
                    </p>
                    <Button onClick={handleAdd} disabled={adding} size="sm">
                        {adding ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : 'Добавить аккаунт'}
                    </Button>
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {connections.map(conn => (
                        <ConnectionCard key={conn.id} conn={conn} onRefresh={refresh} />
                    ))}
                </div>
            )}
        </div>
    )
}
