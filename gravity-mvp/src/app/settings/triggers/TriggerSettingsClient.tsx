"use client"

import { useState } from "react"
import { Plus, Trash2, ToggleLeft, ToggleRight, Zap } from "lucide-react"
import type { TriggerItem } from "./actions"
import { createTrigger, deleteTrigger, toggleTrigger } from "./actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const CONDITION_LABELS: Record<string, string> = {
    days_without_trips: "Дней без поездок",
    segment_sleeping: "Сегмент: Спящий",
    segment_risk: "Риск ухода",
    after_promotion: "После акции (дней без поездок)",
}

const ACTION_LABELS: Record<string, string> = {
    auto_message: "Авто-сообщение",
    manager_task: "Задача менеджеру",
}

interface TriggerSettingsClientProps {
    initialTriggers: TriggerItem[]
}

export function TriggerSettingsClient({ initialTriggers }: TriggerSettingsClientProps) {
    const [triggers, setTriggers] = useState(initialTriggers)
    const [showForm, setShowForm] = useState(false)
    const [form, setForm] = useState({
        name: "",
        condition: "days_without_trips",
        threshold: 3,
        action: "manager_task",
        messageTemplate: "",
        channel: "telegram",
    })
    const [saving, setSaving] = useState(false)

    const handleCreate = async () => {
        setSaving(true)
        try {
            await createTrigger({
                ...form,
                messageTemplate: form.action === "auto_message" ? form.messageTemplate : undefined,
            })
            setShowForm(false)
            setForm({ name: "", condition: "days_without_trips", threshold: 3, action: "manager_task", messageTemplate: "", channel: "telegram" })
            // Reload page to get fresh data
            window.location.reload()
        } finally {
            setSaving(false)
        }
    }

    const handleToggle = async (id: string, isActive: boolean) => {
        await toggleTrigger(id, !isActive)
        setTriggers(prev => prev.map(t => t.id === id ? { ...t, isActive: !isActive } : t))
    }

    const handleDelete = async (id: string) => {
        await deleteTrigger(id)
        setTriggers(prev => prev.filter(t => t.id !== id))
    }

    return (
        <div className="space-y-6">
            {/* Trigger List */}
            {triggers.length === 0 && !showForm ? (
                <div className="flex flex-col items-center justify-center py-12 text-center rounded-xl border border-dashed border-muted-foreground/30  text-muted-foreground">
                    <Zap size={40} className="mb-3 opacity-30" />
                    <p className="font-medium">Нет триггеров</p>
                    <p className="text-xs mt-1 mb-4">Создайте правила для автоматизации коммуникаций</p>
                    <Button onClick={() => setShowForm(true)} className="gap-2">
                        <Plus size={16} /> Создать триггер
                    </Button>
                </div>
            ) : (
                <>
                    <div className="space-y-3">
                        {triggers.map((trigger) => (
                            <div
                                key={trigger.id}
                                className={`flex items-center gap-4 rounded-xl border bg-card p-4 shadow-sm transition-opacity ${
                                    !trigger.isActive ? "opacity-50" : ""
                                }`}
                            >
                                <button
                                    onClick={() => handleToggle(trigger.id, trigger.isActive)}
                                    className="shrink-0"
                                    title={trigger.isActive ? "Деактивировать" : "Активировать"}
                                >
                                    {trigger.isActive ? (
                                        <ToggleRight size={28} className="text-emerald-500" />
                                    ) : (
                                        <ToggleLeft size={28} className="text-muted-foreground" />
                                    )}
                                </button>

                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-0.5">
                                        <span className="text-sm font-bold text-foreground">{trigger.name}</span>
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground uppercase font-medium">
                                            {ACTION_LABELS[trigger.action] || trigger.action}
                                        </span>
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground uppercase font-medium">
                                            {trigger.channel}
                                        </span>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        {CONDITION_LABELS[trigger.condition] || trigger.condition}: {trigger.threshold}
                                        {trigger.messageTemplate && (
                                            <span className="ml-2 italic">«{trigger.messageTemplate.substring(0, 60)}...»</span>
                                        )}
                                    </p>
                                </div>

                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:bg-destructive/10"
                                    onClick={() => handleDelete(trigger.id)}
                                >
                                    <Trash2 size={14} />
                                </Button>
                            </div>
                        ))}
                    </div>

                    {!showForm && (
                        <Button onClick={() => setShowForm(true)} variant="outline" className="gap-2">
                            <Plus size={16} /> Добавить триггер
                        </Button>
                    )}
                </>
            )}

            {/* Create Form */}
            {showForm && (
                <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4 animate-in slide-in-from-top-2 duration-200">
                    <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
                        <Zap size={18} className="text-primary" /> Новый триггер
                    </h3>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-medium text-muted-foreground uppercase mb-1">
                                Название
                            </label>
                            <Input
                                value={form.name}
                                onChange={(e) => setForm({ ...form, name: e.target.value })}
                                placeholder="Не катал 3 дня"
                                className="bg-secondary/50"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-muted-foreground uppercase mb-1">
                                Условие
                            </label>
                            <select
                                value={form.condition}
                                onChange={(e) => setForm({ ...form, condition: e.target.value })}
                                className="flex h-10 w-full rounded-md border bg-secondary/50 px-3 py-2 text-sm"
                            >
                                {Object.entries(CONDITION_LABELS).map(([k, v]) => (
                                    <option key={k} value={k}>{v}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-muted-foreground uppercase mb-1">
                                Порог
                            </label>
                            <Input
                                type="number"
                                value={form.threshold}
                                onChange={(e) => setForm({ ...form, threshold: Number(e.target.value) })}
                                min={1}
                                className="bg-secondary/50"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-muted-foreground uppercase mb-1">
                                Действие
                            </label>
                            <select
                                value={form.action}
                                onChange={(e) => setForm({ ...form, action: e.target.value })}
                                className="flex h-10 w-full rounded-md border bg-secondary/50 px-3 py-2 text-sm"
                            >
                                {Object.entries(ACTION_LABELS).map(([k, v]) => (
                                    <option key={k} value={k}>{v}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-muted-foreground uppercase mb-1">
                                Канал
                            </label>
                            <select
                                value={form.channel}
                                onChange={(e) => setForm({ ...form, channel: e.target.value })}
                                className="flex h-10 w-full rounded-md border bg-secondary/50 px-3 py-2 text-sm"
                            >
                                <option value="telegram">Telegram</option>
                                <option value="whatsapp">WhatsApp</option>
                            </select>
                        </div>
                    </div>

                    {form.action === "auto_message" && (
                        <div>
                            <label className="block text-xs font-medium text-muted-foreground uppercase mb-1">
                                Шаблон сообщения
                            </label>
                            <textarea
                                value={form.messageTemplate}
                                onChange={(e) => setForm({ ...form, messageTemplate: e.target.value })}
                                className="w-full h-24 resize-none rounded-xl border bg-secondary/50 p-3 text-sm outline-none"
                                placeholder="Привет, {name}! Заметили, что вы не катаете уже {days} дней..."
                            />
                            <p className="text-[11px] text-muted-foreground mt-1">
                                Переменные: {'{name}'} — имя, {'{days}'} — дней без поездок, {'{segment}'} — сегмент
                            </p>
                        </div>
                    )}

                    <div className="flex gap-3">
                        <Button onClick={handleCreate} disabled={!form.name || saving} className="gap-2">
                            <Plus size={16} /> {saving ? "Сохранение..." : "Создать"}
                        </Button>
                        <Button variant="outline" onClick={() => setShowForm(false)}>Отмена</Button>
                    </div>
                </div>
            )}
        </div>
    )
}
