"use client"

import { useState, useEffect } from "react"
import { 
    MessageSquare, CheckCircle2, ShieldAlert,
    Trash2, Plus, LogOut, Check, RefreshCw, Smartphone
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { 
    addMaxConnection, 
    disconnectMax, 
    updateMaxConnectionSettings,
    sendMaxMessage
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

    const handleDisconnect = async (id: string, isPersonal = false) => {
        if (!isPersonal && !confirm('Вы уверены, что хотите удалить это подключение?')) return
        
        try {
            if (isPersonal) {
                // Чтобы отключить личный аккаунт, мы просто перезапускаем скрапер
                // который очистит папку сессии (см. maxBrowser.js restart)
                await handleRestartScraper()
                setIsPersonalLoggedIn(false)
                return;
            }

            await disconnectMax(id)
            if (initialConnections.length <= 1) {
                setIsAddingNew(true)
            }
        } catch (err: any) {
            console.error("Failed to disconnect", err)
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
        <div className="flex w-full flex-col gap-8 lg:flex-row animate-in fade-in duration-500">
            <div className="flex flex-1 flex-col gap-6">
                
                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                    <TabsList className="mb-6 grid w-full max-w-md grid-cols-2">
                        <TabsTrigger value="bots" className="gap-2"><MessageSquare size={16}/> Боты (API)</TabsTrigger>
                        <TabsTrigger value="personal" className="gap-2"><Smartphone size={16}/> Личный Аккаунт</TabsTrigger>
                    </TabsList>

                    <TabsContent value="bots" className="space-y-6">
                        <div className="flex items-center justify-between">
                            <div>
                                <h2 className="text-xl font-bold text-foreground">Подключенные боты</h2>
                                <p className="text-sm text-muted-foreground">Управляйте вашими аккаунтами MAX</p>
                            </div>
                            {initialConnections.length > 0 && !isAddingNew && (
                                <Button onClick={() => setIsAddingNew(true)} className="gap-2">
                                    <Plus size={16} /> Добавить бота
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
                                    <div 
                                        key={conn.id} 
                                        className={`relative overflow-hidden rounded-2xl border bg-card p-6 shadow-sm transition-all ${
                                            conn.isDefault ? 'border-primary/50 ring-1 ring-primary/20' : 'hover:border-border/80'
                                        }`}
                                    >
                                        <div className="flex items-start justify-between">
                                            <div className="flex gap-4">
                                                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-blue-100/50">
                                                    <MessageSquare size={24} className="text-blue-600" />
                                                </div>
                                                <div className="flex flex-col">
                                                    {editingId === conn.id ? (
                                                        <div className="flex items-center gap-2 mb-1">
                                                            <Input 
                                                                value={editName}
                                                                onChange={(e) => setEditName(e.target.value)}
                                                                className="h-8 w-40 text-sm"
                                                                autoFocus
                                                            />
                                                            <Button size="icon" variant="ghost" className="h-8 w-8 text-green-600" onClick={() => saveEdit(conn)}>
                                                                <Check size={14} />
                                                            </Button>
                                                            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditingId(null)}>
                                                                <X size={14} />
                                                            </Button>
                                                        </div>
                                                    ) : (
                                                        <div className="flex items-center gap-2 mb-1">
                                                            <h3 className="font-bold text-foreground">{conn.name || 'MAX Bot'}</h3>
                                                            <button 
                                                                onClick={() => startEditing(conn)}
                                                                className="text-xs text-muted-foreground hover:text-foreground underline decoration-dashed"
                                                            >
                                                                изм.
                                                            </button>
                                                        </div>
                                                    )}
                                                    
                                                    <div className="flex items-center gap-3">
                                                        <span className="flex items-center gap-1.5 rounded-full bg-emerald-100/50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
                                                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                                            Бот активен
                                                        </span>
                                                        {conn.isDefault && (
                                                            <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary-foreground">
                                                                Основной
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="mt-3 text-xs text-muted-foreground font-mono">
                                                        Token: {conn.botToken.substring(0, 10)}...
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex flex-col items-end gap-2">
                                                {!conn.isDefault && (
                                                    <Button 
                                                        variant="outline" 
                                                        size="sm" 
                                                        className="text-xs h-8"
                                                        onClick={() => handleSetDefault(conn)}
                                                    >
                                                        Сделать основным
                                                    </Button>
                                                )}
                                                <Button 
                                                    variant="ghost" 
                                                    size="sm" 
                                                    className="text-xs h-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                                    onClick={() => handleDisconnect(conn.id)}
                                                >
                                                    <LogOut size={14} className="mr-1.5" /> Отключить
                                                </Button>
                                            </div>
                                        </div>
                                        
                                        {/* Test Message Section for Bot */}
                                        <div className="mt-4 flex flex-col gap-3 rounded-xl bg-secondary/30 p-4 border border-dashed">
                                            <p className="text-[11px] font-semibold text-muted-foreground uppercase">Тест отправки (Bot API)</p>
                                            <div className="flex gap-3">
                                                <Input 
                                                    placeholder="Номер телефона (79...)"
                                                    value={testPhone}
                                                    onChange={(e) => setTestPhone(e.target.value)}
                                                    className="h-9 text-xs"
                                                />
                                                <Button 
                                                    size="sm" 
                                                    onClick={() => handleSendTest(false, conn.id)}
                                                    disabled={testLoading}
                                                    className="gap-2 shrink-0"
                                                >
                                                    {testLoading ? <RefreshCw size={14} className="animate-spin"/> : <MessageSquare size={14} />}
                                                    Проверить бота
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </TabsContent>

                    <TabsContent value="personal" className="space-y-6">
                         <div className="flex items-center justify-between">
                            <div>
                                <h2 className="text-xl font-bold text-foreground">Личный аккаунт MAX</h2>
                                <p className="text-sm text-muted-foreground">Используйте для отправки сообщений от своего имени</p>
                            </div>
                            {!isScraperOnline && (
                                 <span className="flex items-center gap-1.5 rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-700 border border-red-200">
                                    <ShieldAlert size={14} /> Скрейпер MAX не запущен
                                </span>
                            )}
                        </div>

                        {isPersonalLoggedIn ? (
                             <div className="relative overflow-hidden rounded-2xl border bg-card p-6 shadow-sm border-primary/50 ring-1 ring-primary/20">
                                <div className="flex items-start justify-between">
                                    <div className="flex gap-4">
                                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-100/50">
                                            <Smartphone size={24} className="text-emerald-600" />
                                        </div>
                                        <div className="flex flex-col">
                                            <div className="flex items-center gap-2 mb-1">
                                                <h3 className="font-bold text-foreground">Ваш MAX Аккаунт</h3>
                                            </div>
                                            
                                            <div className="flex items-center gap-3">
                                                <span className="flex items-center gap-1.5 rounded-full bg-emerald-100/50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
                                                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                                    Подключен (Web Scraper)
                                                </span>
                                            </div>
                                            <div className="mt-3 text-xs text-muted-foreground">
                                                Вы можете отправлять сообщения напрямую водителям через веб-интерфейс.
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex flex-col items-end gap-2">
                                         <Button 
                                            variant="ghost" 
                                            size="sm" 
                                            className="text-xs h-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                            onClick={() => handleDisconnect('personal', true)}
                                        >
                                            <LogOut size={14} className="mr-1.5" /> Выйти
                                        </Button>
                                    </div>
                                </div>

                                {/* Test Message Section for Personal */}
                                <div className="mt-6 flex flex-col gap-4 rounded-xl bg-primary/5 p-6 border border-primary/20">
                                    <div className="flex items-center justify-between">
                                        <h4 className="text-sm font-bold">Проверить отправку через браузер</h4>
                                        <span className="text-[10px] text-muted-foreground uppercase bg-background px-2 py-1 rounded-md border">Web Scraper Mode</span>
                                    </div>
                                    <div className="grid gap-3">
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                            <div>
                                                <label className="text-[10px] text-muted-foreground uppercase mb-1 block">Номер получателя</label>
                                                <Input 
                                                    placeholder="Напр. 79991234567"
                                                    value={testPhone}
                                                    onChange={(e) => setTestPhone(e.target.value)}
                                                    className="h-10"
                                                />
                                            </div>
                                            <div>
                                                <label className="text-[10px] text-muted-foreground uppercase mb-1 block">Текст сообщения</label>
                                                <Input 
                                                    placeholder="Текст для теста..."
                                                    value={testMessage}
                                                    onChange={(e) => setTestMessage(e.target.value)}
                                                    className="h-10"
                                                />
                                            </div>
                                        </div>
                                        <Button 
                                            onClick={() => handleSendTest(true)}
                                            disabled={testLoading || !testPhone}
                                            className="w-full gap-2 py-6 text-base"
                                        >
                                            {testLoading ? <RefreshCw size={20} className="animate-spin"/> : <MessageSquare size={20} />}
                                            Отправить тестовое сообщение
                                        </Button>
                                        <p className="text-[10px] text-center text-muted-foreground">
                                            Внимание: при отправке через браузер скрейпер имитирует действия человека. 
                                            Вы увидите результат в логах скрейпера.
                                        </p>
                                    </div>
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
                <div className="flex w-full flex-col max-w-md">
                    <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
                        <div className="border-b bg-muted/20 px-6 py-4">
                            <h2 className="font-semibold text-foreground">Подключение MAX Бота</h2>
                            <p className="mt-1 text-xs text-muted-foreground">
                                Введите токен вашего официального MAX бота
                            </p>
                        </div>
                        
                        <div className="p-6">
                            {error && (
                                <div className="mb-6 flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
                                    <ShieldAlert size={18} className="shrink-0" />
                                    <p>{error}</p>
                                </div>
                            )}

                            <form onSubmit={handleAddBot} className="flex flex-col gap-5">
                                <div>
                                    <label className="mb-2 block text-xs font-medium text-muted-foreground uppercase">
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
                                    <label className="mb-2 block text-xs font-medium text-muted-foreground uppercase">
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
                                
                                <div className="mt-2 flex gap-3">
                                    <Button
                                        type="submit"
                                        disabled={loading || !botToken}
                                        className="flex-1 py-6 text-base shadow-sm"
                                    >
                                        {loading ? 'Подключение...' : 'Подключить бота'}
                                    </Button>
                                    
                                    {initialConnections.length > 0 && (
                                        <Button 
                                            type="button" 
                                            variant="outline"
                                            onClick={() => setIsAddingNew(false)}
                                            className="px-6 py-6"
                                        >
                                            Отмена
                                        </Button>
                                    )}
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            )}
        </div>
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
