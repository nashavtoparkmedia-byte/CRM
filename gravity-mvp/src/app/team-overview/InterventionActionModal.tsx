'use client'

import { useState, useTransition } from 'react'
import { INTERVENTION_ACTIONS, INTERVENTION_ACTION_LABELS, type InterventionAction } from '@/lib/tasks/intervention-action-config'
import { logInterventionAction } from './actions'

interface InterventionActionModalProps {
    managerId: string
    managerName: string
    onClose: () => void
    onDone: () => void
}

export default function InterventionActionModal({ managerId, managerName, onClose, onDone }: InterventionActionModalProps) {
    const [action, setAction] = useState<InterventionAction | null>(null)
    const [comment, setComment] = useState('')
    const [isPending, startTransition] = useTransition()

    const handleConfirm = () => {
        if (!action) return
        startTransition(async () => {
            await logInterventionAction({
                managerId,
                action,
                comment: comment.trim() || undefined,
            })
            onDone()
        })
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/40" onClick={onClose} />
            <div className="relative bg-white rounded-xl w-full max-w-md px-6 py-5 mx-4">
                <h3 className="text-[17px] font-semibold text-[#111827] mb-1">
                    Отметить действие
                </h3>
                <p className="text-[13px] text-[#64748B] mb-4">{managerName}</p>

                {/* Action radios */}
                <div className="space-y-2 mb-4">
                    {INTERVENTION_ACTIONS.map(a => (
                        <label
                            key={a}
                            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors ${
                                action === a
                                    ? 'border-[#2AABEE] bg-blue-50'
                                    : 'border-[#E4ECFC] hover:bg-[#f9fafb]'
                            }`}
                        >
                            <input
                                type="radio"
                                name="intervention-action"
                                value={a}
                                checked={action === a}
                                onChange={() => setAction(a)}
                                className="accent-[#2AABEE]"
                            />
                            <span className="text-[14px] text-[#374151]">
                                {INTERVENTION_ACTION_LABELS[a]}
                            </span>
                        </label>
                    ))}
                </div>

                {/* Comment */}
                <textarea
                    value={comment}
                    onChange={e => setComment(e.target.value)}
                    placeholder="Комментарий (опционально)"
                    className="w-full h-20 px-3 py-2 rounded-lg border border-[#E4ECFC] text-[14px] text-[#374151] placeholder:text-[#94A3B8] resize-none focus:outline-none focus:border-[#2AABEE]"
                />

                {/* Buttons */}
                <div className="flex justify-end gap-2 mt-4">
                    <button
                        onClick={onClose}
                        disabled={isPending}
                        className="px-4 h-[44px] rounded-lg text-[14px] font-medium text-[#6b7280] border border-[#E4ECFC] hover:bg-[#f9fafb] transition-colors"
                    >
                        Отмена
                    </button>
                    <button
                        onClick={handleConfirm}
                        disabled={!action || isPending}
                        className="px-4 h-[44px] rounded-lg text-[14px] font-semibold text-white bg-[#2AABEE] hover:bg-[#1E96D4] disabled:opacity-50 transition-colors"
                    >
                        {isPending ? 'Сохраняю...' : 'Подтвердить'}
                    </button>
                </div>
            </div>
        </div>
    )
}
