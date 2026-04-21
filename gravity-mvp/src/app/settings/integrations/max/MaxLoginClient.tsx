"use client"

import { useState, useEffect } from "react"
import {
    MessageSquare, CheckCircle2, ShieldAlert,
    Trash2, Plus, LogOut, Check, RefreshCw, Smartphone, PauseCircle, PlayCircle, Loader2
} from "lucide-react"
import ChannelSyncBlock from "@/components/ChannelSyncBlock"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import {
    addMaxConnection,
    disconnectMax,
    updateMaxConnectionSettings,
    sendMaxMessage,
    pauseMaxConnection,
    resumeMaxConnection,
    deleteMaxMessages
} from "../../../max-actions"

export default function MaxLoginClient({ initialConnections = [] }: { initialConnections: any[] }) {
    const [isAddingNew, setIsAddingNew] = useState(initialConnections.length === 0)
    const [activeTab, setActiveTab] = useState("bots")
    
    // Auth Form State (Bots)
    const [botToken, setBotToken] = useState('')
    const [name, setName] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // Inline edit state
    const [editingId, setEditingId] = useState<string | null>(null)
    const [editName, setEditName] = useState('')

    // Dialog state for pause/disconnect
    const [pauseDialog, setPauseDialog] = useState<string | null>(null)
    const [resumeDialog, setResumeDialog] = useState<string | null>(null)
    const [disconnectDialog, setDisconnectDialog] = useState<{ id: string; isPersonal?: boolean } | null>(null)
    const [actionLoading, setActionLoading] = useState(false)
    const [isPersonalPaused, setIsPersonalPaused] = useState(false)

    // Personal Account (QR) State
    const [qrUrl, setQrUrl] = useState<string | null>(null)
    const [qrLoading, setQrLoading] = useState(false)
    const [isPersonalLoggedIn, setIsPersonalLoggedIn] = useState(false)
    const [isScraperOnline, setIsScraperOnline] = useState(true)
    const [pollInterval, setPollInterval] = useState<NodeJS.Timeout|null>(null)
    
    // Testing State
    const [testPhone, setTestPhone] = useState('')
    const [testName, setTestName] = useState('')
    const [testMessage, setTestMessage] = useState('Привет! Это тестовое сообщение из Yoko CRM.')
    const [testLoading, setTestLoading] = useState(false)

    // Check MAX Scraper status
    const checkPersonalStatus = async () => {
        try {
            const res = await fetch("http://localhost:3005/status")
            if (!res.ok) throw new Error("Scraper returned error")
            const data = await res.json()
            const loggedIn = data.isLoggedIn ?? data.isReady ?? false
            setIsPersonalLoggedIn(loggedIn)
            setIsScraperOnline(true)

            if (!loggedIn) {
                // Используем qrUpdatedAt как cache-buster — QR обновится автоматически
                const ts = data.qrUpdatedAt || Date.now()
                setQrUrl(`http://localhost:3005/qr?t=${ts}`)
            } else {
                setQrUrl(null)
            }
        } catch (err) {
            console.error("Scraper not running or unreachable", err)
            setIsScraperOnline(false)
        }
    }

    // Start polling when on personal tab
    useEffect(() => {
        if (activeTab === "personal") {
            checkPersonalStatus()
            const interval = setInterval(checkPersonalStatus, 2000)
            setPollInterval(interval)
            
            return () => clearInterval(interval)
        } else if (pollInterval) {
            clearInterval(pollInterval)
        }
    }, [activeTab])

    const handleRestartScraper = async () => {
        setQrLoading(true)
        setError(null)
        try {
            const res = await fetch("http://localhost:3005/restart", { method: "POST" })
            if (!res.ok) throw new Error("Не удалось связаться со скрейпером")
            
            // Ждем немного, пока playwright начнет инициализацию
            setTimeout(() => {
                checkPersonalStatus()
                setQrLoading(false)
            }, 3000)
        } catch (err: any) {
            console.error("Failed to restart scraper", err)
            setError("Скрейпер MAX не отвечает. Убедитесь, что он запущен.")
            setQrLoading(false)
        }
    }

    const handleAddBot = async (e: React.FormEvent) => {
        e.preventDefault()
        setError(null)
        setLoading(true)
        
        try {
            await addMaxConnection(botToken, name || "MAX Bot")
            setBotToken('')
            setName('')
            setIsAddingNew(false)
        } catch (err: any) {
            setError(err.message || 'Ошибка подключения')
        } finally {
            setLoading(false)
        }
    }

    const handleDisconnectConfirm = async (deleteMessages: boolean) => {
        if (!disconnectDialog) return
        setActionLoading(true)
        try {
            if (disconnectDialog.isPersonal) {
                await handleRestartScraper()
                setIsPersonalLoggedIn(false)
            } else {
                if (deleteMessages) await deleteMaxMessages(disconnectDialog.id)
                await disconnectMax(disconnectDialog.id)
                if (initialConnections.length <= 1) setIsAddingNew(true)
            }
        } catch (err: any) {
            console.error("Failed to disconnect", err)
        } finally {
            setActionLoading(false)
            setDisconnectDialog(null)
        }
    }

    const handlePauseConfirm = async (deleteMessages: boolean) => {
        if (!pauseDialog) return
        setActionLoading(true)
        try {
            if (pauseDialog === 'personal') {
                setIsPersonalPaused(true)
            } else {
                await pauseMaxConnection(pauseDialog, deleteMessages)
                window.location.reload()
            }
        } finally {
            setActionLoading(false)
            setPauseDialog(null)
        }
    }

    const handleResumeConfirm = async (catchUp: boolean) => {
        if (!resumeDialog) return
        setActionLoading(true)
        try {
            if (resumeDialog === 'personal') {
                setIsPersonalPaused(false)
            } else {
                await resumeMaxConnection(resumeDialog, catchUp)
                window.location.reload()
            }
        } finally {
            setActionLoading(false)
            setResumeDialog(null)
        }
    }

    const handleSetDefault = async (connection: any) => {
        if (connection.isDefault) return
        try {
            await updateMaxConnectionSettings(connection.id, connection.name || '', true)
        } catch (err: any) {
            alert(err.message)
        }
    }

    const startEditing = (connection: any) => {
        setEditingId(connection.id)
        setEditName(connection.name || '')
    }

    const handleSendTest = async (isPersonal: boolean, connId?: string) => {
        if (!testPhone) {
            alert("Введите номер телефона")
            return
        }
        setTestLoading(true)
        try {
            await sendMaxMessage(testPhone, testMessage, { 
                connectionId: connId, 
                isPersonal,
                name: testName 
            })
            alert("Сообщение отправлено!")
        } catch (err: any) {
            alert(err.message || "Ошибка при отправке")
        } finally {
            setTestLoading(false)
        }
    }

    const saveEdit = async (connection: any) => {
        try {
            await updateMaxConnectionSettings(connection.id, editName, connection.isDefault)
            setEditingId(null)
        } catch (err: any) {
            alert(err.message)
        }
    }

    return (
        <>
        <div className="flex w-full flex-col gap-8 lg:flex-row animate-in fade-in duration-500">
            <div className="flex flex-1 flex-col gap-6">
                
                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                    <TabsList className="mb-6 inline-flex h-10 rounded-xl border bg-muted/40 p-1 w-full max-w-sm">
                        <TabsTrigger value="bots" className="gap-2 flex-1 data-[state=active]:bg-background data-[state=active]:shadow-sm rounded-lg transition-all"><MessageSquare size={15}/> Боты (API)</TabsTrigger>
                        <TabsTrigger value="personal" className="gap-2 flex-1 data-[state=active]:bg-background data-[state=active]:shadow-sm rounded-lg transition-all"><Smartphone size={15}/> Личный аккаунт</TabsTrigger>
                    </TabsList>

                    <TabsContent value="bots" className="space-y-4">
                        <div className="flex items-center justify-between">
                            <h2 className="text-base font-semibold text-foreground">Подключенные боты ({initialConnections.length})</h2>
                            {initialConnections.length > 0 && !isAddingNew && (
                                <Button onClick={() => setIsAddingNew(true)} variant="outline" size="sm" className="gap-1.5">
                                    <Plus size={14} /> Добавить бота
                                </Button>
                            )}
                        </div>

                        {initialConnections.length === 0 ? (
                            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed p-12 text-center text-muted-foreground">
                                <MessageSquare className="mb-4 h-12 w-12 opacity-20" />
                                <p>Нет подключенных ботов</p>
                                <p className="text-xs">Добавьте бота справа, чтобы начать писать в MAX</p>
                            </div>
                        ) : (
                            <div className="grid gap-4">
                                {initialConnections.map((conn) => (
                                    <div key={conn.id} className="rounded-2xl border bg-card p-5 shadow-sm transition-all">
                                        <div className="flex items-start gap-3 mb-3">
                                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600">
                                                <MessageSquare size={18} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                {editingId === conn.id ? (
                                                    <div className="flex items-center gap-2 mb-0.5">
                                                        <Input
                                                            value={editName}
                                                            onChange={(e) => setEditName(e.target.value)}
                                                            className="h-7 w-36 text-sm"
                                                            autoFocus
                                                        />
                                                        <Button size="icon" variant="ghost" className="h-7 w-7 text-green-600" onClick={() => saveEdit(conn)}>
                                                            <Check size={13} />
                                                        </Button>
                                                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditingId(null)}>
                                                            <X size={13} />
                                                        </Button>
                                                    </div>
                                                ) : (
                                                    <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                                                        <span className="font-semibold text-sm text-foreground">{conn.name || 'MAX Bot'}</span>
                                                        <button
                                                            onClick={() => startEditing(conn)}
                                                            className="text-[10px] text-muted-foreground hover:text-foreground underline decoration-dashed"
                                                        >
                                                            изм.
                                                        </button>
                                                        {conn.isDefault && (
                                                            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-foreground/70">основной</span>
                                                        )}
                                                    </div>
                                                )}
                                                <div className="flex items-center gap-2">
                                                    {conn.isPaused ? (
                                                        <span className="flex items-center gap-1 text-[11px] text-amber-600">
                                                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> На паузе
                                                        </span>
                                                    ) : (
                                                        <span className="flex items-center gap-1 text-[11px] text-emerald-600">
                                                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Активен
                                                        </span>
                                                    )}
                                                    <span className="text-[11px] text-muted-foreground font-mono">{conn.botToken.substring(0, 10)}...</span>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="flex items-center justify-end gap-1 pt-3 border-t border-dashed">
                                            {!conn.isDefault && (
                                                <Button variant="ghost" size="sm" className="h-8 px-3 text-xs text-muted-foreground hover:bg-secondary" onClick={() => handleSetDefault(conn)}>
                                                    Основным
                                                </Button>
                                            )}
                                            {conn.isPaused ? (
                                                <Button variant="ghost" size="sm" className="h-8 px-3 text-xs text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700" onClick={() => setResumeDialog(conn.id)}>
                                                    <PlayCircle size={13} className="mr-1.5" /> Включить
                                                </Button>
                                            ) : (
                                                <Button variant="ghost" size="sm" className="h-8 px-3 text-xs text-amber-600 hover:bg-amber-50 hover:text-amber-700" onClick={() => setPauseDialog(conn.id)}>
                                                    <PauseCircle size={13} className="mr-1.5" /> Пауза
                                                </Button>
                                            )}
                                            <Button variant="ghost" size="sm" className="h-8 px-3 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDisconnectDialog({ id: conn.id })}>
                                                <LogOut size={13} className="mr-1.5" /> Отключить
                                            </Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </TabsContent>

                    <TabsContent value="personal" className="space-y-4">
                        <div className="flex items-center justify-between">
                            <h2 className="text-base font-semibold text-foreground">Подключенные аккаунты (1)</h2>
                            {!isScraperOnline && (
                                <span className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                                    <span className="h-1.5 w-1.5 rounded-full bg-red-500" /> Скрейпер не запущен
                                </span>
                            )}
                        </div>

                        {isPersonalLoggedIn ? (
                            <div className="rounded-2xl border bg-card p-5 shadow-sm transition-all">
                                <div className="flex items-start gap-3 mb-3">
                                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-purple-100 text-purple-600">
                                        <Smartphone size={18} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="font-semibold text-sm text-foreground">MAX</div>
                                        <div className="flex items-center gap-2 mt-0.5">
                                            {process.env.NEXT_PUBLIC_MAX_SCRAPER_PHONE && (
                                                <span className="text-xs text-muted-foreground">{process.env.NEXT_PUBLIC_MAX_SCRAPER_PHONE}</span>
                                            )}
                                            {isPersonalPaused ? (
                                                <span className="flex items-center gap-1 text-[11px] text-amber-600">
                                                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> На паузе
                                                </span>
                                            ) : (
                                                <span className="flex items-center gap-1 text-[11px] text-emerald-600">
                                                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Подключено
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* История сообщений */}
                                <ChannelSyncBlock channel="max" scraperUrl="http://localhost:3005" />

                                <div className="flex items-center justify-end gap-1 pt-3 mt-3 border-t border-dashed">
                                    {isPersonalPaused ? (
                                        <Button variant="ghost" size="sm" className="h-8 px-3 text-xs text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700" onClick={() => setResumeDialog('personal')}>
                                            <PlayCircle size={13} className="mr-1.5" /> Включить
                                        </Button>
                                    ) : (
                                        <Button variant="ghost" size="sm" className="h-8 px-3 text-xs text-amber-600 hover:bg-amber-50 hover:text-amber-700" onClick={() => setPauseDialog('personal')}>
                                            <PauseCircle size={13} className="mr-1.5" /> Пауза
                                        </Button>
                                    )}
                                    <Button variant="ghost" size="sm" className="h-8 px-3 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDisconnectDialog({ id: 'personal', isPersonal: true })}>
                                        <LogOut size={13} className="mr-1.5" /> Выйти
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center rounded-2xl border p-8 text-center bg-card shadow-sm">
                                {error && (activeTab === "personal") && (
                                     <div className="mb-6 w-full max-w-sm flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
                                        <ShieldAlert size={18} className="shrink-0" />
                                        <p>{error}</p>
                                    </div>
                                )}
                                <div className="mb-6 select-none bg-white p-3 rounded-xl shadow-sm border inline-flex items-center justify-center" style={{ width: 320, height: 320 }}>
                                    {qrLoading ? (
                                        <div className="flex flex-col items-center text-muted-foreground">
                                            <RefreshCw className="h-8 w-8 animate-spin mb-4" />
                                            <span className="text-sm">Запуск браузера и загрузка QR...</span>
                                        </div>
                                    ) : !isScraperOnline ? (
                                        <div className="flex flex-col items-center text-muted-foreground">
                                            <ShieldAlert className="h-12 w-12 text-destructive mb-4 opacity-50" />
                                            <span className="text-sm">Скрейпер офлайн</span>
                                            <Button variant="link" onClick={checkPersonalStatus} className="text-xs mt-2">Проверить связь</Button>
                                        </div>
                                    ) : qrUrl ? (
                                        <img 
                                            src={qrUrl} 
                                            alt="MAX QR Code" 
                                            style={{ width: 294, height: 294 }}
                                            className="object-contain mix-blend-multiply" 
                                            onError={() => setQrUrl(null)} // fallback if not generated yet
                                        />
                                    ) : (
                                        <div className="flex flex-col items-center text-muted-foreground">
                                            <MessageSquare className="h-12 w-12 opacity-20 mb-4" />
                                            <span className="text-sm">Ожидание QR кода...</span>
                                        </div>
                                    )}
                                </div>

                                <h3 className="text-lg font-bold">Отсканируйте код</h3>
                                <p className="text-sm text-muted-foreground mt-2 max-w-sm mb-6">
                                    Откройте приложение MAX на телефоне и отсканируйте этот QR-код для привязки аккаунта в CRM. Код обновляется автоматически.
                                </p>
                                
                                <Button 
                                    variant="outline" 
                                    className="gap-2" 
                                    onClick={handleRestartScraper}
                                    disabled={qrLoading}
                                >
                                    <RefreshCw size={16} className={qrLoading ? "animate-spin" : ""} />
                                    Принудительно обновить QR
                                </Button>
                            </div>
                        )}
                    </TabsContent>
                </Tabs>
            </div>

            {/* Right side - Add Form for Bots only */}
            {isAddingNew && activeTab === "bots" && (
                <div className="flex w-full flex-col max-w-sm">
                    <div className="rounded-2xl border bg-card shadow-sm p-5">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-base font-semibold text-foreground">Подключение бота</h2>
                            {initialConnections.length > 0 && (
                                <Button type="button" variant="ghost" size="sm" onClick={() => setIsAddingNew(false)}>Отмена</Button>
                            )}
                        </div>

                        {error && (
                            <div className="mb-4 flex items-center gap-2 rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                                <ShieldAlert size={16} className="shrink-0" />
                                <p>{error}</p>
                            </div>
                        )}

                        <form onSubmit={handleAddBot} className="flex flex-col gap-4">
                            <div>
                                <label className="mb-1.5 block text-xs font-medium text-muted-foreground uppercase">
                                    Название в CRM
                                </label>
                                <Input
                                    placeholder="Напр. Бот поддержки 1"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    className="bg-secondary/50"
                                />
                            </div>
                            <div>
                                <label className="mb-1.5 block text-xs font-medium text-muted-foreground uppercase">
                                    Bot Token
                                </label>
                                <Input
                                    placeholder="Введите токен из настроек MAX"
                                    value={botToken}
                                    onChange={(e) => setBotToken(e.target.value)}
                                    required
                                    className="bg-secondary/50 font-mono text-xs"
                                />
                            </div>

                            <Button
                                type="submit"
                                disabled={loading || !botToken}
                                className="w-full"
                            >
                                {loading ? 'Подключение...' : 'Подключить бота'}
                            </Button>
                        </form>
                    </div>
                </div>
            )}
        </div>

        {/* PAUSE DIALOG */}
        <Dialog open={!!pauseDialog} onOpenChange={(o) => !o && setPauseDialog(null)}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Поставить на паузу</DialogTitle>
                    <DialogDescription>
                        Подключение останется активным. Новые сообщения будут накапливаться и не отображаться в CRM.
                    </DialogDescription>
                </DialogHeader>
                <div className="py-2">
                    <p className="text-sm text-muted-foreground">Что сделать с текущими сообщениями?</p>
                </div>
                <DialogFooter className="flex-col gap-2 sm:flex-col">
                    <Button variant="outline" onClick={() => handlePauseConfirm(false)} disabled={actionLoading} className="w-full">
                        {actionLoading && <Loader2 size={14} className="mr-2 animate-spin" />}
                        Сохранить сообщения
                    </Button>
                    <Button variant="destructive" onClick={() => handlePauseConfirm(true)} disabled={actionLoading} className="w-full">
                        Удалить сообщения и поставить на паузу
                    </Button>
                    <Button variant="ghost" onClick={() => setPauseDialog(null)} className="w-full">Отмена</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        {/* RESUME DIALOG */}
        <Dialog open={!!resumeDialog} onOpenChange={(o) => !o && setResumeDialog(null)}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Возобновить</DialogTitle>
                    <DialogDescription>
                        Канал снова будет активен и сообщения начнут поступать в CRM.
                    </DialogDescription>
                </DialogHeader>
                <div className="py-2">
                    <p className="text-sm text-muted-foreground">Что сделать с накопленными сообщениями?</p>
                </div>
                <DialogFooter className="flex-col gap-2 sm:flex-col">
                    <Button onClick={() => handleResumeConfirm(true)} disabled={actionLoading} className="w-full">
                        {actionLoading && <Loader2 size={14} className="mr-2 animate-spin" />}
                        Загрузить накопленные сообщения
                    </Button>
                    <Button variant="outline" onClick={() => handleResumeConfirm(false)} disabled={actionLoading} className="w-full">
                        Удалить накопленные и возобновить
                    </Button>
                    <Button variant="ghost" onClick={() => setResumeDialog(null)} className="w-full">Отмена</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        {/* DISCONNECT DIALOG */}
        <Dialog open={!!disconnectDialog} onOpenChange={(o) => !o && setDisconnectDialog(null)}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Отключить аккаунт</DialogTitle>
                    <DialogDescription>
                        {disconnectDialog?.isPersonal
                            ? 'Выйти из личного аккаунта MAX? Для повторного подключения потребуется QR-код.'
                            : 'Бот будет отключён от CRM. Вы сможете подключить его снова позже.'}
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter className="flex-col gap-2 sm:flex-col">
                    <Button variant="destructive" onClick={() => handleDisconnectConfirm(true)} disabled={actionLoading} className="w-full">
                        {actionLoading && <Loader2 size={14} className="mr-2 animate-spin" />}
                        Отключить и удалить сообщения
                    </Button>
                    {!disconnectDialog?.isPersonal && (
                        <Button variant="outline" onClick={() => handleDisconnectConfirm(false)} disabled={actionLoading} className="w-full">
                            Отключить, сохранить сообщения
                        </Button>
                    )}
                    <Button variant="ghost" onClick={() => setDisconnectDialog(null)} className="w-full">Отмена</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        </>
    )
}

function X({ size = 24, className = "" }: { size?: number, className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
        </svg>
    )
}
