"use client"

import type { DaySummary } from "../actions"
import { ActivityCell } from "./ActivityCell"

interface ActivityGridProps {
    cells: DaySummary[]
}

function parseLocalDate(dateStr: string) {
    const [year, month, day] = dateStr.split('-').map(Number)
    return new Date(year, month - 1, day)
}

function getDayLabel(dateStr: string): string {
    return parseLocalDate(dateStr).getDate().toString()
}

function getWeekdayClass(dateStr: string): string {
    const date = parseLocalDate(dateStr)
    const day = date.getDay()
    // Weekend days slightly dimmed
    return day === 0 || day === 6 ? "text-muted-foreground/60" : "text-muted-foreground"
}

export function ActivityGrid({ cells }: ActivityGridProps) {
    return (
        <div className="flex items-center gap-[1px]">
            {cells.map((cell) => (
                <div key={cell.date} className="flex-shrink-0 w-3">
                    <ActivityCell summary={cell} />
                </div>
            ))}
        </div>
    )
}
