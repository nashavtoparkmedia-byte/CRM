"use client"

import type { ReactNode } from "react"
import { Loader2, Send } from "lucide-react"

export interface ContactChannelBadge {
    label: string
    className: string
    title: string
}

interface ContactChannelRowProps {
    provider: string
    providerLabel: string
    icon: string
    dotClassName: string
    dotTitle: string
    badges: ContactChannelBadge[]
    detail?: ReactNode
    isWriting: boolean
    onWrite: () => void
    canWrite?: boolean
    writeDisabledReason?: string
    muted?: boolean
    error?: string | null
}

export default function ContactChannelRow({
    provider,
    providerLabel,
    icon,
    dotClassName,
    dotTitle,
    badges,
    detail,
    isWriting,
    onWrite,
    canWrite = true,
    writeDisabledReason,
    muted = false,
    error,
}: ContactChannelRowProps) {
    const statusTitle = [providerLabel, ...badges.map(badge => badge.label)].join(' · ')
    const actionTitle = canWrite
        ? `Написать в ${providerLabel}`
        : writeDisabledReason || `Сейчас нельзя написать в ${providerLabel}`

    return (
        <div className="group/channel mb-0.5 min-w-0" data-channel-row={provider}>
            <div className="grid h-[26px] w-full min-w-0 grid-cols-[7px_14px_auto_minmax(0,1fr)_auto] items-center gap-x-1.5 overflow-hidden">
                <span
                    className={`inline-block h-[7px] w-[7px] rounded-full ${dotClassName}`}
                    title={dotTitle}
                    data-channel-status-dot
                />
                <span className={`text-[11px] ${muted ? 'opacity-50' : ''}`} aria-hidden="true">
                    {icon}
                </span>
                <span className={`whitespace-nowrap text-[11px] ${muted ? 'text-gray-400' : 'text-gray-600'}`}>
                    {providerLabel}
                </span>
                <div
                    className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap"
                    title={statusTitle}
                    data-channel-badges
                >
                    {badges.map((badge, index) => (
                        <span
                            key={`${badge.label}-${index}`}
                            className={`shrink-0 rounded px-1 py-px font-semibold ${index === 0 ? 'text-[9px]' : 'text-[8px]'} ${badge.className}`}
                            title={badge.title}
                        >
                            {badge.label}
                        </span>
                    ))}
                    {detail}
                </div>
                <button
                    type="button"
                    onClick={onWrite}
                    disabled={isWriting || !canWrite}
                    title={actionTitle}
                    className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-[#3390EC]/5 px-[2px] py-0.5 text-[10px] font-semibold text-[#3390EC] transition-colors hover:bg-[#3390EC]/15 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400 disabled:opacity-100"
                    data-channel-action
                    data-channel-can-write={canWrite ? 'true' : 'false'}
                >
                    {isWriting ? <Loader2 size={10} className="animate-spin" /> : <Send size={9} />}
                    Написать
                </button>
            </div>
            {error && (
                <div className="group/err relative ml-5 mb-0.5 inline-block">
                    <span className="cursor-default text-[10px] leading-tight text-red-500">Ошибка доставки</span>
                    <div className="pointer-events-none absolute bottom-full left-0 z-50 mb-1 hidden group-hover/err:block">
                        <div className="max-w-[220px] whitespace-pre-wrap rounded-lg bg-[#333] px-2.5 py-1.5 text-[10px] leading-tight text-white shadow-lg">
                            {error.length > 120 ? `${error.substring(0, 120)}…` : error}
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
