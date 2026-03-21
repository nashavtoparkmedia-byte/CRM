"use client"

import { TrendingUp, Car, AlertTriangle, Moon, Target, Activity } from "lucide-react"
import type { DashboardStats } from "../actions"

const KPI_CONFIG = [
    { key: "activeDriversToday", label: "Активные водители", icon: Car, color: "text-emerald-500", bgColor: "bg-emerald-50", emoji: "🚕" },
    { key: "tripsToday", label: "Поездки сегодня", icon: Activity, color: "text-blue-500", bgColor: "bg-blue-50", emoji: "📈" },
    { key: "tripsLast7Days", label: "Поездки 7 дней", icon: TrendingUp, color: "text-indigo-500", bgColor: "bg-indigo-50", emoji: "📊" },
    { key: "driversAtRisk", label: "В риске", icon: AlertTriangle, color: "text-red-500", bgColor: "bg-red-50", emoji: "⚠️" },
    { key: "sleepingDrivers", label: "Спящие", icon: Moon, color: "text-amber-500", bgColor: "bg-amber-50", emoji: "💤" },
    { key: "promotionsActive", label: "Акции сегодня", icon: Target, color: "text-purple-500", bgColor: "bg-purple-50", emoji: "🎯" },
] as const

export function DashboardKPI({ stats }: { stats: DashboardStats }) {
    return (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {KPI_CONFIG.map((kpi) => {
                const value = stats[kpi.key as keyof DashboardStats]
                const Icon = kpi.icon

                return (
                    <div
                        key={kpi.key}
                        className="group relative overflow-hidden rounded-2xl border bg-card p-5 shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5"
                    >
                        {/* Background accent */}
                        <div className={`absolute top-0 right-0 w-20 h-20 ${kpi.bgColor} rounded-full -mr-8 -mt-8 opacity-60 transition-transform group-hover:scale-125`} />

                        <div className="relative">
                            <div className={`inline-flex items-center justify-center w-10 h-10 rounded-xl ${kpi.bgColor} mb-3`}>
                                <Icon size={20} className={kpi.color} />
                            </div>
                            <div className="text-3xl font-bold text-foreground tabular-nums">
                                {typeof value === 'number' ? value.toLocaleString('ru-RU') : value}
                            </div>
                            <div className="text-xs font-medium text-muted-foreground mt-1 uppercase tracking-wider">
                                {kpi.label}
                            </div>
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
