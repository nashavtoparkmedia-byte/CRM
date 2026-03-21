"use client"

import { useMemo } from "react"
import { cn } from "@/lib/utils"

interface SegmentCount {
    profitable: number
    medium: number
    small: number
    dropped: number
    inactive: number
    unknown: number
}

interface SegmentCardsProps {
    counts: SegmentCount
    activeSegment: string
    onSegmentClick: (segment: string) => void
}

export function SegmentCards({
    counts,
    activeSegment,
    onSegmentClick
}: SegmentCardsProps) {
    const segments = useMemo(() => [
        { id: 'profitable', label: 'Прибыльные', color: 'bg-emerald-500', hover: 'hover:bg-emerald-50', active: 'ring-emerald-500 bg-emerald-50', textColor: 'text-emerald-700', icon: '🟢' },
        { id: 'medium', label: 'Средние', color: 'bg-amber-400', hover: 'hover:bg-amber-50', active: 'ring-amber-400 bg-amber-50', textColor: 'text-amber-700', icon: '🟡' },
        { id: 'small', label: 'Малые', color: 'bg-orange-500', hover: 'hover:bg-orange-50', active: 'ring-orange-500 bg-orange-50', textColor: 'text-orange-700', icon: '🟠' },
        { id: 'dropped', label: 'Выпал', color: 'bg-blue-500', hover: 'hover:bg-blue-50', active: 'ring-blue-500 bg-blue-50', textColor: 'text-blue-700', icon: '🔵' },
    ], [])

    // Calculate fleet total as sum of active segments
    const fleetTotal = useMemo(() => {
        return (counts.profitable || 0) + (counts.medium || 0) + (counts.small || 0) + (counts.dropped || 0)
    }, [counts])

    const calculatePercentage = (count: number) => {
        if (fleetTotal === 0) return 0
        return Math.round((count / fleetTotal) * 100)
    }

    return (
        <div className="flex flex-wrap items-center gap-2 p-1 bg-gray-50/50 rounded-2xl border border-gray-100 mb-4">
            {segments.map((s) => {
                const count = (counts as any)[s.id] || 0
                const percent = calculatePercentage(count)
                const isActive = activeSegment === s.id

                return (
                    <button
                        key={s.id}
                        onClick={() => onSegmentClick(isActive ? 'all' : s.id)}
                        className={cn(
                            "flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all duration-200 border border-transparent group relative overflow-hidden",
                            s.hover,
                            isActive ? cn("ring-2 ring-offset-0 shadow-sm border-white", s.active) : "bg-white shadow-sm hover:shadow-md"
                        )}
                        title={`${s.label}: ${count} водит. (${percent}%)`}
                    >
                        {/* Segment Icon/Dot */}
                        <div className={cn("w-2 h-2 rounded-full", s.color)} />
                        
                        <div className="flex flex-col items-start leading-none">
                            <span className="text-[10px] font-black uppercase tracking-wider text-gray-400 group-hover:text-gray-500 transition-colors">
                                {s.label}
                            </span>
                            <div className="flex items-baseline gap-1.5 mt-0.5">
                                <span className={cn("text-sm font-black", isActive ? s.textColor : "text-gray-900")}>
                                    {count}
                                </span>
                                <span className="text-[10px] font-bold text-gray-400">
                                    ({percent}%)
                                </span>
                            </div>
                        </div>

                        {/* Visual polish: accent bar */}
                        {isActive && (
                            <div className={cn("absolute left-0 top-0 bottom-0 w-1", s.color)} />
                        )}
                    </button>
                )
            })}
        </div>
    )
}
