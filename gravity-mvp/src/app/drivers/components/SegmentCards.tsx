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
        { id: 'profitable', label: 'Прибыльные', dot: 'bg-emerald-500' },
        { id: 'medium',     label: 'Средние',    dot: 'bg-amber-400' },
        { id: 'small',      label: 'Малые',      dot: 'bg-orange-500' },
        { id: 'dropped',    label: 'Выпавшие',   dot: 'bg-[#3390EC]' },
    ], [])

    const fleetTotal = useMemo(() => {
        return (counts.profitable || 0) + (counts.medium || 0) + (counts.small || 0) + (counts.dropped || 0)
    }, [counts])

    const calculatePercentage = (count: number) => {
        if (fleetTotal === 0) return 0
        return Math.round((count / fleetTotal) * 100)
    }

    return (
        <div className="flex flex-wrap items-center gap-1">
            {segments.map((s) => {
                const count = (counts as any)[s.id] || 0
                const percent = calculatePercentage(count)
                const isActive = activeSegment === s.id

                return (
                    <button
                        key={s.id}
                        onClick={() => onSegmentClick(isActive ? 'all' : s.id)}
                        className={cn(
                            "h-[32px] px-3 rounded-lg flex items-center gap-2 text-[13px] font-semibold transition-colors",
                            isActive
                                ? "bg-[#3390EC] text-white"
                                : "text-[#8A9099] hover:bg-[#F0F2F5]"
                        )}
                        title={`${s.label}: ${count} водит. (${percent}%)`}
                    >
                        <span className={cn("w-[6px] h-[6px] rounded-full shrink-0", s.dot)} />
                        <span>{s.label}</span>
                        <span
                            className={cn(
                                "h-[18px] min-w-[18px] px-1 rounded-full text-[11px] font-bold flex items-center justify-center leading-none",
                                isActive ? "bg-white/25 text-white" : "bg-[#F0F2F5] text-[#8A9099]"
                            )}
                        >
                            {count}
                        </span>
                        {count > 0 && (
                            <span
                                className={cn(
                                    "text-[11px] font-medium",
                                    isActive ? "text-white/70" : "text-[#B0B5BA]"
                                )}
                            >
                                {percent}%
                            </span>
                        )}
                    </button>
                )
            })}
        </div>
    )
}
