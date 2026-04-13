'use client'

import { useState, useEffect, useRef } from 'react'
import { X } from 'lucide-react'

interface CloseReasonModalProps {
    reasons: { value: string; label: string }[]
    isSaving: boolean
    onConfirm: (reason: string, comment: string) => void
    onClose: () => void
}

export default function CloseReasonModal({
    reasons,
    isSaving,
    onConfirm,
    onClose,
}: CloseReasonModalProps) {
    const [selectedReason, setSelectedReason] = useState('')
    const [comment, setComment] = useState('')
    const overlayRef = useRef<HTMLDivElement>(null)
    const firstRadioRef = useRef<HTMLInputElement>(null)

    // Focus first radio on mount
    useEffect(() => {
        firstRadioRef.current?.focus()
    }, [])

    // Esc to close
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [onClose])

    // Click outside to close
    const handleOverlayClick = (e: React.MouseEvent) => {
        if (e.target === overlayRef.current) onClose()
    }

    return (
        <div
            ref={overlayRef}
            onClick={handleOverlayClick}
            className="absolute inset-0 z-50 bg-white/95 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-200"
        >
            <div className="w-full max-w-[420px] bg-white rounded-2xl shadow-2xl border border-gray-100 p-5 space-y-4">
                <div className="flex items-center justify-between">
                    <h4 className="text-[15px] font-bold text-gray-900">
                        Причина закрытия
                    </h4>
                    <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-full transition-colors">
                        <X className="w-4 h-4 text-gray-400" />
                    </button>
                </div>

                <div className="space-y-3">
                    <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Причина</label>
                        <div className="space-y-1">
                            {reasons.map((r, i) => (
                                <label
                                    key={r.value}
                                    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-colors ${
                                        selectedReason === r.value
                                            ? 'bg-blue-50 border border-blue-200'
                                            : 'bg-gray-50 border border-transparent hover:bg-gray-100'
                                    }`}
                                >
                                    <input
                                        ref={i === 0 ? firstRadioRef : undefined}
                                        type="radio"
                                        name="closeReason"
                                        value={r.value}
                                        checked={selectedReason === r.value}
                                        onChange={() => setSelectedReason(r.value)}
                                        className="w-4 h-4 text-blue-600 accent-blue-600"
                                    />
                                    <span className="text-[13px] text-gray-800">{r.label}</span>
                                </label>
                            ))}
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Комментарий</label>
                        <textarea
                            value={comment}
                            onChange={(e) => setComment(e.target.value.slice(0, 500))}
                            placeholder="Необязательно..."
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-[13px] outline-none focus:border-blue-500 transition-colors h-20 resize-none"
                        />
                        <div className="text-[10px] text-right text-gray-400">{comment.length}/500</div>
                    </div>
                </div>

                <div className="flex gap-2 pt-2">
                    <button
                        onClick={onClose}
                        className="flex-1 py-2.5 rounded-xl bg-gray-50 text-gray-600 text-[13px] font-bold hover:bg-gray-100 transition-colors"
                    >
                        Отмена
                    </button>
                    <button
                        onClick={() => onConfirm(selectedReason, comment)}
                        disabled={!selectedReason || isSaving}
                        className="flex-[2] py-2.5 rounded-xl bg-blue-600 text-white text-[13px] font-bold hover:bg-blue-700 transition-all shadow-md shadow-blue-200 disabled:opacity-50 disabled:shadow-none disabled:cursor-not-allowed"
                    >
                        {isSaving ? 'Закрытие...' : 'Подтвердить'}
                    </button>
                </div>
            </div>
        </div>
    )
}
