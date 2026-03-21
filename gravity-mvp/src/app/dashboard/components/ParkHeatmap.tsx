"use client"

import type { HeatmapDay } from "../actions"

function getHeatColor(percent: number): string {
    if (percent >= 80) return 'bg-emerald-500'
    if (percent >= 60) return 'bg-emerald-400'
    if (percent >= 40) return 'bg-amber-400'
    if (percent >= 20) return 'bg-amber-500'
    if (percent > 0)   return 'bg-red-400'
    return 'bg-red-500'
}

export function ParkHeatmap({ data }: { data: HeatmapDay[] }) {
    return (
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
            <div className="mb-4">
                <h3 className="text-lg font-bold text-foreground">Активность парка</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Последние 7 дней</p>
            </div>

            <div className="flex gap-2 justify-between">
                {data.map((day) => (
                    <div key={day.date} className="flex-1 text-center group">
                        <div className="text-[10px] font-bold text-muted-foreground uppercase mb-2">
                            {day.dayName}
                        </div>
                        <div
                            className={`h-14 rounded-xl ${getHeatColor(day.activePercent)} transition-all group-hover:scale-105 group-hover:shadow-md flex items-center justify-center`}
                            title={`${day.activeDrivers} из ${day.totalDrivers} водителей (${day.activePercent}%)`}
                        >
                            <span className="text-white text-xs font-bold opacity-90">
                                {day.activePercent}%
                            </span>
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-1.5">
                            {day.activeDrivers}/{day.totalDrivers}
                        </div>
                    </div>
                ))}
            </div>

            {/* Legend */}
            <div className="flex items-center justify-center gap-3 mt-4 text-[10px] text-muted-foreground">
                <div className="flex items-center gap-1">
                    <div className="w-3 h-3 rounded bg-red-500" />
                    <span>0-20%</span>
                </div>
                <div className="flex items-center gap-1">
                    <div className="w-3 h-3 rounded bg-amber-400" />
                    <span>20-60%</span>
                </div>
                <div className="flex items-center gap-1">
                    <div className="w-3 h-3 rounded bg-emerald-500" />
                    <span>60-100%</span>
                </div>
            </div>
        </div>
    )
}
