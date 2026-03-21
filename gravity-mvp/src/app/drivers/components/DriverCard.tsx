"use client"

import { useState } from "react"
import { Send, Phone, TrendingUp } from "lucide-react"
import type { DriverCard as DriverCardType } from "../actions"
import { logManagerCall } from "../actions"
import { ActivityGrid } from "./ActivityGrid"
import { SegmentBadge } from "./SegmentBadge"
import { ScoringDot } from "./ScoringDot"
import { DriverScoreBar } from "./DriverScoreBar"
import { Button } from "@/components/ui/button"

interface DriverCardProps {
    driver: DriverCardType
    onMessage: (driver: DriverCardType) => void
}

export function DriverCard({ driver, onMessage }: DriverCardProps) {
    const [callLogged, setCallLogged] = useState(false)

    const handleCall = async (e: React.MouseEvent) => {
        e.stopPropagation()
        await logManagerCall(driver.id)
        setCallLogged(true)
        setTimeout(() => setCallLogged(false), 2000)
    }

    // Show only last 7 days for mini grid
    const miniCells = driver.cells.slice(-7)

    return (
        <div
            className="
                group relative flex flex-col rounded-2xl border bg-card p-5
                shadow-sm transition-all duration-200
                hover:shadow-lg hover:-translate-y-0.5 hover:border-primary/20
                cursor-pointer
            "
            onClick={() => window.location.href = `/drivers/${driver.id}`}
        >
            {/* Header: Name + Segment + Dot */}
            <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2.5 min-w-0">
                    <ScoringDot status={driver.computedStatus} />
                    <div className="min-w-0">
                        <h3 className="text-sm font-bold text-foreground truncate group-hover:text-primary transition-colors">
                            {driver.fullName}
                        </h3>
                        {driver.phone && (
                            <p className="text-[11px] text-muted-foreground truncate">
                                {driver.phone}
                            </p>
                        )}
                    </div>
                </div>
                <SegmentBadge segment={driver.segment} />
            </div>

            {/* Score Bar */}
            <div className="mb-3">
                <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                        Скоринг
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                        {driver.weeklyTrips} поезд/нед
                    </span>
                </div>
                <DriverScoreBar score={driver.score} />
            </div>

            {/* Mini Activity Grid - last 7 days */}
            <div className="mb-4">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1 block">
                    Активность (7 дн)
                </span>
                <ActivityGrid cells={miniCells} />
            </div>

            {/* Stats row */}
            <div className="flex items-center gap-3 mb-3 text-xs text-muted-foreground">
                <div className="flex items-center gap-1">
                    <TrendingUp size={12} />
                    <span>{driver.weeklyTrips} поездок</span>
                </div>
                {driver.daysWithoutTrips > 0 && (
                    <div className="text-red-500 font-medium">
                        {driver.daysWithoutTrips}д без поездок
                    </div>
                )}
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2 mt-auto pt-2 border-t">
                <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1 gap-1.5 h-8 text-xs"
                    onClick={(e) => {
                        e.stopPropagation()
                        onMessage(driver)
                    }}
                >
                    <Send size={12} className="text-blue-500" />
                    Написать
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    className={`flex-1 gap-1.5 h-8 text-xs transition-colors ${callLogged ? 'bg-emerald-100 text-emerald-700' : ''}`}
                    onClick={handleCall}
                >
                    <Phone size={12} className={callLogged ? "text-emerald-600" : "text-green-500"} />
                    {callLogged ? "✓ Записано" : "Позвонить"}
                </Button>
            </div>
        </div>
    )
}
