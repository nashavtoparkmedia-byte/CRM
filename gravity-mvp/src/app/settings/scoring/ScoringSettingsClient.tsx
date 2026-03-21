"use client"

import { useState } from "react"
import { updateThresholdSettings } from "./actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Settings, Save } from "lucide-react"

interface ScoringSettingsClientProps {
    initialThresholds: Record<string, number>
}

const FIELDS = [
    { key: "profitable_min", label: "Прибыльный (мин. поездок/неделю)", group: "segment" },
    { key: "medium_min", label: "Средний (мин. поездок/неделю)", group: "segment" },
    { key: "small_min", label: "Малый (мин. поездок/неделю)", group: "segment" },
    { key: "sleeping_days", label: "Спящий (дней без поездок)", group: "segment" },
    { key: "risk_days", label: "Риск ухода (дней без поездок)", group: "status" },
    { key: "gone_days", label: "Ушёл (дней без поездок)", group: "status" },
]

export function ScoringSettingsClient({ initialThresholds }: ScoringSettingsClientProps) {
    const [values, setValues] = useState(initialThresholds)
    const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")

    const handleSave = async () => {
        setStatus("saving")
        try {
            await updateThresholdSettings(values)
            setStatus("saved")
            setTimeout(() => setStatus("idle"), 2000)
        } catch {
            setStatus("error")
        }
    }

    const segmentFields = FIELDS.filter(f => f.group === "segment")
    const statusFields = FIELDS.filter(f => f.group === "status")

    return (
        <div className="space-y-8">
            {/* Segments */}
            <div className="rounded-xl border bg-card p-6 shadow-sm">
                <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground mb-4">
                    <Settings size={20} className="text-primary" />
                    Пороги сегментов
                </h2>
                <p className="text-sm text-muted-foreground mb-6">
                    Определяют, к какому сегменту относится водитель на основе количества поездок за неделю.
                </p>
                <div className="space-y-4">
                    {segmentFields.map((field) => (
                        <div key={field.key} className="flex items-center gap-4">
                            <label className="flex-1 text-sm font-medium text-foreground">
                                {field.label}
                            </label>
                            <Input
                                type="number"
                                value={values[field.key]}
                                onChange={(e) =>
                                    setValues({ ...values, [field.key]: Number(e.target.value) })
                                }
                                className="w-24 h-10 text-center bg-secondary/50"
                                min={0}
                            />
                        </div>
                    ))}
                </div>
            </div>

            {/* Statuses */}
            <div className="rounded-xl border bg-card p-6 shadow-sm">
                <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground mb-4">
                    <Settings size={20} className="text-primary" />
                    Пороги статусов
                </h2>
                <p className="text-sm text-muted-foreground mb-6">
                    Определяют статус водителя на основе количества дней без поездок подряд.
                </p>
                <div className="space-y-4">
                    {statusFields.map((field) => (
                        <div key={field.key} className="flex items-center gap-4">
                            <label className="flex-1 text-sm font-medium text-foreground">
                                {field.label}
                            </label>
                            <Input
                                type="number"
                                value={values[field.key]}
                                onChange={(e) =>
                                    setValues({ ...values, [field.key]: Number(e.target.value) })
                                }
                                className="w-24 h-10 text-center bg-secondary/50"
                                min={0}
                            />
                        </div>
                    ))}
                </div>
            </div>

            {/* Save */}
            <div className="flex items-center gap-4">
                <Button onClick={handleSave} disabled={status === "saving"} className="gap-2 px-8">
                    <Save size={16} />
                    {status === "saving" ? "Сохранение..." : "Сохранить"}
                </Button>
                {status === "saved" && (
                    <span className="text-sm text-emerald-600 font-medium animate-in fade-in">
                        ✓ Сохранено
                    </span>
                )}
                {status === "error" && (
                    <span className="text-sm text-destructive font-medium animate-in fade-in">
                        Ошибка сохранения
                    </span>
                )}
            </div>
        </div>
    )
}
