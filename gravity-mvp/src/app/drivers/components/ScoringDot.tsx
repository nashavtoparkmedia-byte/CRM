"use client"

interface ScoringDotProps {
    status: string  // active / risk / gone
    size?: "sm" | "md"
}

const STATUS_CONFIG: Record<string, { color: string; title: string }> = {
    active: { color: "bg-emerald-500", title: "Активный" },
    risk:   { color: "bg-amber-400",   title: "Риск ухода" },
    gone:   { color: "bg-[#F06A6A]",   title: "Ушёл" },
}

export function ScoringDot({ status, size = "md" }: ScoringDotProps) {
    const config = STATUS_CONFIG[status] || STATUS_CONFIG.active
    const sizeClass = size === "sm" ? "h-[6px] w-[6px]" : "h-[8px] w-[8px]"

    return (
        <span
            className={`inline-block rounded-full ${sizeClass} ${config.color} shrink-0`}
            title={config.title}
        />
    )
}
