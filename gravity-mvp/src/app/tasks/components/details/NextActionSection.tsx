'use client'

import { Zap } from 'lucide-react'

interface NextActionSectionProps {
    nextActionId: string | null | undefined
    dueAt: string | null
    isOverdue: boolean
    scenario: string
    nextActions: { id: string; label: string }[]
    onNextActionChange: (actionId: string) => void
    onShiftDue: (shift: 'hour' | 'day') => void
}

export default function NextActionSection({
    nextActionId,
    dueAt,
    isOverdue,
    scenario,
    nextActions,
    onNextActionChange,
    onShiftDue,
}: NextActionSectionProps) {
    return (
        <div className={`p-3 border rounded-xl space-y-2 transition-colors duration-300 ${isOverdue ? 'bg-red-50/80 border-red-200/60' : 'bg-gray-50/50 border-gray-100'}`}>
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-section-label">
                    <Zap className="w-3 h-3" />
                    Следующее действие
                </div>
                <div className="text-section-label">
                    Срок
                </div>
            </div>

            <div className="flex items-center justify-between gap-3">
                <select
                    value={nextActionId || ''}
                    onChange={(e) => onNextActionChange(e.target.value)}
                    className="bg-transparent border-none outline-none text-primary-value cursor-pointer flex-1"
                >
                    <option value="">Не выбрано</option>
                    {nextActions.map((a) => (
                        <option key={a.id} value={a.id}>{a.label}</option>
                    ))}
                </select>

                <div className="flex flex-col items-end gap-1 shrink-0">
                    {dueAt && (
                        <span className="text-meta bg-white/80 px-2 py-0.5 rounded border border-gray-100 shadow-sm">
                            {new Date(dueAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, {new Date(dueAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                    )}
                    <div className="flex gap-1">
                        <button
                            onClick={() => onShiftDue('hour')}
                            className="text-meta px-1.5 py-0.5 bg-white border border-gray-200 hover:bg-gray-100 hover:border-blue-200 hover:!text-[#4F46E5] rounded transition-all cursor-pointer shadow-sm"
                        >
                            +1ч
                        </button>
                        <button
                            onClick={() => onShiftDue('day')}
                            className="text-meta px-1.5 py-0.5 bg-blue-50 border border-blue-100 hover:bg-blue-100 hover:!text-blue-700 rounded !text-[#4F46E5] transition-all cursor-pointer shadow-sm"
                        >
                            +1д
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
