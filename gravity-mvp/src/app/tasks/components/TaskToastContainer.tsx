'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskToastContainer — renders the toast queue bottom-center.
// One-liner toasts, auto-dismiss in 3s. Telegram-style simplicity.
// ═══════════════════════════════════════════════════════════════════

import { useToastStore } from '@/lib/tasks/toast-store'
import { X } from 'lucide-react'

const KIND_STYLES: Record<string, string> = {
    error:   'bg-[#FEE2E2] text-[#B91C1C] border-[#FCA5A5]',
    success: 'bg-[#DCFCE7] text-[#166534] border-[#86EFAC]',
    info:    'bg-[#0F172A] text-white border-[#334155]',
}

export default function TaskToastContainer() {
    const items = useToastStore(s => s.items)
    const dismiss = useToastStore(s => s.dismiss)

    if (items.length === 0) return null

    return (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 pointer-events-none">
            {items.map(t => (
                <div
                    key={t.id}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border shadow-sm text-[13px] font-medium pointer-events-auto ${
                        KIND_STYLES[t.kind] ?? KIND_STYLES.info
                    }`}
                >
                    <span>{t.text}</span>
                    <button
                        onClick={() => dismiss(t.id)}
                        className="opacity-60 hover:opacity-100 transition-opacity"
                        aria-label="Закрыть"
                    >
                        <X className="w-3 h-3" />
                    </button>
                </div>
            ))}
        </div>
    )
}
