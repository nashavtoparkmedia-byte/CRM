'use client'

import { Check } from 'lucide-react'

interface TaskFooterActionsProps {
    onResolve: (resolution: 'done' | 'cancelled') => void
}

export default function TaskFooterActions({ onResolve }: TaskFooterActionsProps) {
    return (
        <div className="px-4 py-3 flex items-center gap-3">
            <button
                onClick={() => onResolve('done')}
                style={{ height: '36px', padding: '8px 14px', fontSize: '14px', fontWeight: 500, borderRadius: '8px', width: 'auto' }}
                className="flex items-center justify-center gap-1.5 bg-[#DCFCE7] text-[#166534] hover:bg-[#bbf7d0] transition-colors"
            >
                <Check className="w-4 h-4" />
                Выполнено
            </button>
            <button
                onClick={() => onResolve('cancelled')}
                style={{ height: '36px', padding: '8px 14px', fontSize: '14px', fontWeight: 500, borderRadius: '8px', width: 'auto' }}
                className="flex items-center justify-center gap-1 bg-[#F3F4F6] text-[#374151] hover:bg-[#E5E7EB] transition-colors"
            >
                Отменить
            </button>
        </div>
    )
}
