"use client"

import Link from "next/link"
import { Smartphone } from "lucide-react"

/**
 * Shared header + tabs for the Telephony settings group. Used by both
 *   /settings/integrations/telephony      (connection / status)
 *   /settings/integrations/telephony-ai   (rubric / dictionaries / model)
 *
 * Both routes render the same coloured icon + "Телефония" title, then
 * a tab strip with the two sub-pages. From the operator's point of view
 * it feels like one settings panel with two tabs — even though they're
 * separate Next.js routes underneath.
 */

export type TelephonyTabKey = 'connection' | 'ai'

const TABS: { key: TelephonyTabKey; label: string; href: string }[] = [
    { key: 'connection', label: 'Подключение', href: '/settings/integrations/telephony' },
    { key: 'ai',         label: 'AI-анализ',   href: '/settings/integrations/telephony-ai' },
]

export default function TelephonyTabs({ active }: { active: TelephonyTabKey }) {
    return (
        <header className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
                    <Smartphone className="h-5 w-5 text-primary" />
                </div>
                <div>
                    <h1 className="text-[20px] font-semibold leading-tight text-foreground">Телефония</h1>
                    <p className="text-[13px] text-muted-foreground">
                        SIP-trunk МультиФон, FreeSWITCH, WebRTC, AI-анализ звонков.
                    </p>
                </div>
            </div>

            <div className="flex gap-1 border-b border-border">
                {TABS.map(t => (
                    <Link
                        key={t.key}
                        href={t.href}
                        className={[
                            'px-3 py-2 text-[14px] font-medium border-b-2 transition-colors',
                            active === t.key
                                ? 'border-primary text-foreground'
                                : 'border-transparent text-muted-foreground hover:text-foreground',
                        ].join(' ')}
                    >
                        {t.label}
                    </Link>
                ))}
            </div>
        </header>
    )
}
