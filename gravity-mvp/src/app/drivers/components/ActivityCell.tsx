"use client"

import { useState } from "react"
import type { DaySummary } from "../actions"

interface ActivityCellProps {
    summary: DaySummary
}

/**
 * Determine cell background color based on priority:
 * 1. hadPromotion → blue
 * 2. tripCount > 0 → green
 * 3. else → red
 */
function getCellColor(s: DaySummary): string {
    if (s.hadPromotion) return "bg-blue-400"
    if (s.tripCount > 0) return "bg-emerald-400"
    return "bg-red-400"
}

/**
 * Get the highest priority pictogram for display in the cell.
 * Priority: 🎯 > 📞 > 📩 > ⚡ > 🤖
 */
function getPrimaryIcon(s: DaySummary): string | null {
    if (s.hadGoalAchieved) return "🎯"
    if (s.hadManagerCall) return "📞"
    if (s.hadManagerMessage) return "📩"
    if (s.hadAutoMessage) return "⚡"
    if (s.hadAiAction) return "🤖"
    return null
}

/**
 * Get all actions for tooltip display
 */
function getAllActions(s: DaySummary): string[] {
    const actions: string[] = []
    if (s.hadGoalAchieved) actions.push("🎯 Цель достигнута")
    if (s.hadManagerCall) actions.push("📞 Звонок менеджера")
    if (s.hadManagerMessage) actions.push("📩 Сообщение менеджера")
    if (s.hadAutoMessage) actions.push("⚡ Авто-сообщение")
    if (s.hadAiAction) actions.push("🤖 AI агент")
    if (s.hadPromotion) actions.push("🟦 Акция")
    return actions
}

function formatDate(dateStr: string): string {
    const d = new Date(dateStr)
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })
}

export function ActivityCell({ summary }: ActivityCellProps) {
    const [showTooltip, setShowTooltip] = useState(false)
    const bgColor = getCellColor(summary)
    const icon = getPrimaryIcon(summary)
    const actions = getAllActions(summary)

    return (
        <div
            className="relative"
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
        >
            <div
                className={`
                    flex h-3 w-3 items-center justify-center rounded-[2px]
                    ${bgColor} 
                    transition-all duration-150
                    hover:scale-125 hover:shadow-md
                    cursor-default
                    text-[6px] leading-none
                `}
            >
                {icon && <span className="drop-shadow-sm select-none scale-90">{icon}</span>}
            </div>

            {/* Tooltip */}
            {showTooltip && (
                <div className="absolute -top-1 left-1/2 z-[100] -translate-x-1/2 -translate-y-full pointer-events-none">
                    <div className="rounded-xl border border-gray-100 bg-white/95 backdrop-blur-md p-3 shadow-2xl min-w-[150px] text-xs animate-in fade-in zoom-in-95 duration-150 ring-1 ring-black/5">
                        <div className="font-bold text-foreground mb-1 border-b pb-1">
                            {formatDate(summary.date)}
                        </div>
                        <div className="flex justify-between items-center py-1">
                            <span className="text-muted-foreground">Поездок:</span>
                            <span className="font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded text-[10px]">
                                {summary.tripCount}
                            </span>
                        </div>
                        {actions.length > 0 && (
                            <div className="mt-1 flex flex-col gap-1 pt-1">
                                {actions.map((a, i) => (
                                    <div key={i} className="flex items-center gap-1.5 text-[10px] font-medium text-foreground py-0.5">
                                        {a}
                                    </div>
                                ))}
                            </div>
                        )}
                        {/* Arrow */}
                        <div className="absolute left-1/2 -bottom-1 -translate-x-1/2 w-2.5 h-2.5 rotate-45 border-r border-b bg-white" />
                    </div>
                </div>
            )}
        </div>
    )
}
