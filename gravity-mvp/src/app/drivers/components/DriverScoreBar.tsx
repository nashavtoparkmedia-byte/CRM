"use client"

interface DriverScoreBarProps {
    score: number | null
}

function getScoreColor(score: number): string {
    if (score >= 70) return "bg-emerald-500"
    if (score >= 40) return "bg-amber-500"
    return "bg-red-500"
}

function getScoreLabel(score: number): string {
    if (score >= 70) return "Высокий"
    if (score >= 40) return "Средний"
    return "Низкий"
}

function getScoreTrackColor(score: number): string {
    if (score >= 70) return "bg-emerald-100"
    if (score >= 40) return "bg-amber-100"
    return "bg-red-100"
}

export function DriverScoreBar({ score }: DriverScoreBarProps) {
    const value = score ?? 0
    const color = getScoreColor(value)
    const trackColor = getScoreTrackColor(value)
    const label = getScoreLabel(value)

    return (
        <div className="flex items-center gap-2.5">
            <div className={`relative h-2 flex-1 rounded-full ${trackColor} overflow-hidden`}>
                <div
                    className={`absolute inset-y-0 left-0 rounded-full ${color} transition-all duration-500`}
                    style={{ width: `${value}%` }}
                />
            </div>
            <span className="text-xs font-bold tabular-nums min-w-[32px] text-right text-foreground">
                {value}
            </span>
        </div>
    )
}
