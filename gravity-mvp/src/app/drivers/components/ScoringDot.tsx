"use client"

interface ScoringDotProps {
    status: string  // active / risk / gone
    size?: "sm" | "md"
}

const STATUS_CONFIG: Record<string, { color: string; title: string }> = {
    active: { color: "bg-emerald-500", title: "Активный" },
    risk:   { color: "bg-amber-500",   title: "Риск ухода" },
    gone:   { color: "bg-red-500",     title: "Ушёл" },
}

export function ScoringDot({ status, size = "md" }: ScoringDotProps) {
    const config = STATUS_CONFIG[status] || STATUS_CONFIG.active
    const sizeClass = size === "sm" ? "h-2 w-2" : "h-3 w-3"

    return (
        <span
            className={`
                inline-block rounded-full ${sizeClass} ${config.color}
                shadow-sm ring-2 ring-white
                flex-shrink-0
            `}
            title={config.title}
        />
    )
}
