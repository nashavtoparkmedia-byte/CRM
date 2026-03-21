"use client"

interface SegmentBadgeProps {
    segment: string
}

const SEGMENT_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
    profitable: { label: "Прибыльный", bg: "bg-emerald-100", text: "text-emerald-700" },
    medium:     { label: "Средний",    bg: "bg-blue-100",    text: "text-blue-700" },
    small:      { label: "Малый",      bg: "bg-amber-100",   text: "text-amber-700" },
    sleeping:   { label: "Спящий",     bg: "bg-gray-100",    text: "text-gray-600" },
    unknown:    { label: "—",          bg: "bg-gray-50",     text: "text-gray-400" },
}

export function SegmentBadge({ segment }: SegmentBadgeProps) {
    const config = SEGMENT_CONFIG[segment] || SEGMENT_CONFIG.unknown

    return (
        <span
            className={`
                inline-flex items-center rounded-full px-2.5 py-0.5
                text-[11px] font-medium leading-none
                ${config.bg} ${config.text}
                transition-colors
            `}
        >
            {config.label}
        </span>
    )
}
