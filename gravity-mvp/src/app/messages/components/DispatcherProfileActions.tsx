"use client"

import { useState } from "react"
import { Check, Copy, ExternalLink } from "lucide-react"

import type { YandexDispatcherTarget } from "@/lib/driver-profiles/dispatcher-links"

interface DispatcherProfileActionsProps {
    target?: YandexDispatcherTarget | null
    compact?: boolean
}

export default function DispatcherProfileActions({
    target,
    compact = false,
}: DispatcherProfileActionsProps) {
    const [copied, setCopied] = useState<'profile' | 'phone' | null>(null)

    if (!target) return null

    const copyValue = async (kind: 'profile' | 'phone', value: string | null) => {
        if (!value || !navigator.clipboard) return
        try {
            await navigator.clipboard.writeText(value)
            setCopied(kind)
            window.setTimeout(() => setCopied(current => current === kind ? null : current), 1500)
        } catch {
            setCopied(null)
        }
    }

    return (
        <div className={`flex min-w-0 items-center gap-1 ${compact ? 'mt-0.5' : 'mt-1.5'}`} data-testid="dispatcher-profile-actions">
            {target.url && (
                <a
                    href={target.url}
                    target="_blank"
                    rel="noreferrer"
                    title={target.mode === 'deep_link'
                        ? `Открыть профиль в диспетчерской «${target.parkName}»`
                        : `Открыть список водителей парка «${target.parkName}»`}
                    className="inline-flex h-6 min-w-0 items-center gap-1 rounded bg-blue-50 px-1.5 text-[9px] font-semibold text-[#3390EC] hover:bg-blue-100"
                >
                    <ExternalLink size={10} className="shrink-0" />
                    <span className="truncate">{target.mode === 'deep_link' ? 'Диспетчерская' : 'Открыть парк'}</span>
                </a>
            )}
            {target.externalDriverProfileId && (
                <button
                    type="button"
                    onClick={() => void copyValue('profile', target.externalDriverProfileId)}
                    title="Скопировать внешний ID профиля"
                    aria-label="Скопировать внешний ID профиля"
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-gray-100 text-gray-500 hover:bg-gray-200"
                >
                    {copied === 'profile' ? <Check size={10} className="text-emerald-600" /> : <Copy size={10} />}
                </button>
            )}
            {target.phone && (
                <button
                    type="button"
                    onClick={() => void copyValue('phone', target.phone)}
                    title="Скопировать телефон"
                    aria-label="Скопировать телефон водителя"
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-gray-100 text-gray-500 hover:bg-gray-200"
                >
                    {copied === 'phone' ? <Check size={10} className="text-emerald-600" /> : <Copy size={10} />}
                </button>
            )}
        </div>
    )
}
