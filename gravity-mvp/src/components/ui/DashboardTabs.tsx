'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
    { label: 'Обзор парка', href: '/' },
    { label: 'Команда', href: '/team-overview' },
]

export function DashboardTabs() {
    const pathname = usePathname()

    return (
        <div className="flex gap-1 border-b border-[#E4ECFC]">
            {TABS.map(tab => {
                const isActive = tab.href === '/'
                    ? pathname === '/'
                    : pathname.startsWith(tab.href)

                return (
                    <Link
                        key={tab.href}
                        href={tab.href}
                        className={`
                            px-4 py-2.5 text-[15px] font-medium transition-colors duration-150
                            border-b-2 -mb-[1px]
                            ${isActive
                                ? 'border-[#2AABEE] text-[#2AABEE]'
                                : 'border-transparent text-[#64748B] hover:text-[#0F172A]'
                            }
                        `}
                    >
                        {tab.label}
                    </Link>
                )
            })}
        </div>
    )
}
