"use client"

import { useState, useEffect } from "react"
import { Send, Phone, MessageSquare, Zap, Target, Bot, Truck, Clock } from "lucide-react"
import type { TimelineEvent } from "./timeline-actions"
import { sendDriverMessage, logDriverCall } from "./timeline-actions"
import { Button } from "@/components/ui/button"

// ─── Event icon + color mapping ────────────────────────────────────────────

const EVENT_CONFIG: Record<string, { icon: typeof Send; color: string; label: string }> = {
    message: { icon: MessageSquare, color: "text-blue-500", label: "Сообщение" },
    call: { icon: Phone, color: "text-green-500", label: "Звонок" },
    auto_message: { icon: Zap, color: "text-amber-500", label: "Авто-сообщение" },
    trigger_fired: { icon: Zap, color: "text-purple-500", label: "Триггер" },
    goal_achieved: { icon: Target, color: "text-emerald-500", label: "Цель достигнута" },
    ai_action: { icon: Bot, color: "text-cyan-500", label: "AI" },
    trip: { icon: Truck, color: "text-green-600", label: "Поездка" },
}

const CHANNEL_LABELS: Record<string, string> = {
    telegram: "Telegram",
    max: "MAX",
    whatsapp: "WhatsApp",
    phone: "Телефон",
    auto: "Авто",
    ai: "AI",
    system: "Система",
}

// ─── Timeline Component ────────────────────────────────────────────────────

interface DriverTimelineProps {
    driverId: string
    events: TimelineEvent[]
    telegramConnections?: any[]
    maxConnections?: any[]
}

export function DriverTimeline({ driverId, events, telegramConnections = [], maxConnections = [] }: DriverTimelineProps) {
    const [channel, setChannel] = useState<"telegram" | "max">("telegram")
    const [message, setMessage] = useState("")
    const [sendStatus, setSendStatus] = useState<"idle" | "sending" | "sent" | "error">("idle")
    const [callStatus, setCallStatus] = useState<"idle" | "logging" | "logged">("idle")
    
    // Derived state for the active connection based on selected channel
    const activeConnections = channel === "telegram" ? telegramConnections : maxConnections
    
    const [selectedConnection, setSelectedConnection] = useState<string>(
        activeConnections.find((c: any) => c.isDefault)?.id || activeConnections[0]?.id || ""
    )

    // Reset selected connection when switching channels
    useEffect(() => {
        setSelectedConnection(activeConnections.find((c: any) => c.isDefault)?.id || activeConnections[0]?.id || "")
    }, [channel, activeConnections])

    const handleSendMessage = async () => {
        if (!message.trim()) return
        setSendStatus("sending")
        try {
            await sendDriverMessage(driverId, channel, message, selectedConnection)
            setSendStatus("sent")
            setMessage("")
            setTimeout(() => setSendStatus("idle"), 2000)
        } catch {
            setSendStatus("error")
        }
    }

    const handleLogCall = async () => {
        setCallStatus("logging")
        try {
            await logDriverCall(driverId)
            setCallStatus("logged")
            setTimeout(() => setCallStatus("idle"), 2000)
        } catch {
            setCallStatus("idle")
        }
    }

    return (
        <div className="space-y-6">
            {/* Quick Actions */}
            <div className="flex flex-col gap-3">
                <div className="flex gap-2 p-1 bg-secondary rounded-xl w-fit">
                    <button
                        onClick={() => setChannel("telegram")}
                        className={`px-4 py-1 text-xs font-medium rounded-lg transition-colors ${channel === "telegram" ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                        Telegram
                    </button>
                    <button
                        onClick={() => setChannel("max")}
                        className={`px-4 py-1 text-xs font-medium rounded-lg transition-colors ${channel === "max" ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                        MAX
                    </button>
                </div>

                {activeConnections.length > 0 ? (
                    <div className="flex gap-2 items-center text-sm text-muted-foreground">
                        <span className="whitespace-nowrap">Отправить с:</span>
                        <select 
                            value={selectedConnection}
                            onChange={(e) => setSelectedConnection(e.target.value)}
                            className="rounded-lg border bg-secondary p-1.5 text-xs text-foreground outline-none focus:ring-2 focus:ring-primary/50"
                            disabled={sendStatus === "sending"}
                        >
                            {activeConnections.map((c: any) => (
                                <option key={c.id} value={c.id}>
                                    {c.name || 'Аккаунт без имени'} {c.phoneNumber ? `(${c.phoneNumber})` : ''} {c.isDefault ? '- Основной' : ''}
                                </option>
                            ))}
                        </select>
                    </div>
                ) : (
                    <div className="text-xs text-amber-600 bg-amber-50 rounded-lg p-2">
                        Нет подключенных аккаунтов {channel === "telegram" ? "Telegram" : "MAX"}.
                    </div>
                )}
                <div className="flex gap-3">
                    <div className="flex-1 flex gap-2">
                        <input
                            type="text"
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
                            placeholder="Написать сообщение..."
                            className="flex-1 h-10 rounded-lg border bg-secondary/50 px-3 text-sm outline-none focus:ring-2 focus:ring-primary/50"
                            disabled={sendStatus === "sending"}
                        />
                        <Button
                            size="sm"
                            onClick={handleSendMessage}
                            disabled={!message.trim() || sendStatus === "sending"}
                            className="h-10 gap-1.5"
                        >
                            <Send size={14} />
                            {sendStatus === "sent" ? "✓" : "Отправить"}
                        </Button>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handleLogCall}
                        disabled={callStatus === "logging"}
                        className={`h-10 gap-1.5 ${callStatus === "logged" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : ""}`}
                    >
                        <Phone size={14} />
                        {callStatus === "logged" ? "✓ Записано" : "📞 Позвонил"}
                    </Button>
                </div>
            </div>

            {/* Timeline Feed */}
            {events.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center rounded-xl border border-dashed border-muted-foreground/30 text-muted-foreground">
                    <Clock size={40} className="mb-3 opacity-30" />
                    <p className="font-medium">Нет событий</p>
                    <p className="text-xs mt-1">Отправьте сообщение или зафиксируйте звонок</p>
                </div>
            ) : (
                <div className="relative">
                    {/* Timeline line */}
                    <div className="absolute left-5 top-0 bottom-0 w-px bg-border" />

                    <div className="space-y-0">
                        {events.map((event) => {
                            const config = EVENT_CONFIG[event.eventType] || EVENT_CONFIG.message
                            const Icon = config.icon
                            const channelLabel = CHANNEL_LABELS[event.channel] || event.channel
                            const time = new Date(event.createdAt)
                            const timeStr = time.toLocaleDateString("ru-RU", {
                                day: "numeric",
                                month: "short",
                            }) + " " + time.toLocaleTimeString("ru-RU", {
                                hour: "2-digit",
                                minute: "2-digit",
                            })

                            return (
                                <div key={event.id} className="relative flex gap-4 py-3 group">
                                    {/* Icon circle */}
                                    <div className={`relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-background bg-white shadow-sm ${config.color}`}>
                                        <Icon size={16} />
                                    </div>

                                    {/* Content */}
                                    <div className="flex-1 min-w-0 pt-1">
                                        <div className="flex items-center gap-2 mb-0.5">
                                            <span className="text-sm font-semibold text-foreground">
                                                {config.label}
                                            </span>
                                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-secondary text-muted-foreground uppercase">
                                                {channelLabel}
                                            </span>
                                            {event.direction === "outbound" && (
                                                <span className="text-[10px] text-blue-500">→ исходящее</span>
                                            )}
                                            {event.direction === "inbound" && (
                                                <span className="text-[10px] text-green-500">← входящее</span>
                                            )}
                                        </div>
                                        {event.content && (
                                            <p className="text-sm text-muted-foreground line-clamp-2">
                                                {event.content}
                                            </p>
                                        )}
                                        <div className="flex items-center gap-2 mt-1">
                                            <span className="text-[11px] text-muted-foreground/60">
                                                {timeStr}
                                            </span>
                                            {event.createdBy && event.createdBy !== "system" && (
                                                <span className="text-[11px] text-muted-foreground/60">
                                                    • {event.createdBy}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </div>
            )}
        </div>
    )
}
