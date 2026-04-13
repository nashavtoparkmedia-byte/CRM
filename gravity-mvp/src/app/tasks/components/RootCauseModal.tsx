'use client'

import { useState, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { ROOT_CAUSES } from '@/lib/tasks/root-cause-config'

const RESOLUTION_TYPES = [
    { value: 'contacted', label: 'Контакт выполнен' },
    { value: 'reassigned', label: 'Переназначена' },
    { value: 'closed', label: 'Задача закрыта' },
] as const

interface RootCauseModalProps {
    taskId: string
    isSaving: boolean
    onConfirm: (params: {
        taskId: string
        resolutionType: 'contacted' | 'reassigned' | 'closed'
        rootCause: string
        comment: string
    }) => void
    onClose: () => void
}

export default function RootCauseModal({
    taskId,
    isSaving,
    onConfirm,
    onClose,
}: RootCauseModalProps) {
    const [resolutionType, setResolutionType] = useState<string>('contacted')
    const [rootCause, setRootCause] = useState('')
    const [comment, setComment] = useState('')
    const overlayRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [onClose])

    const handleOverlayClick = (e: React.MouseEvent) => {
        if (e.target === overlayRef.current) onClose()
    }

    return (
        <div
            ref={overlayRef}
            onClick={handleOverlayClick}
            className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 animate-in fade-in duration-200"
        >
            <div
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-[400px] bg-white rounded-xl border border-gray-100 p-5 space-y-4"
            >
                <div className="flex items-center justify-between">
                    <h4 className="text-[15px] font-semibold text-gray-900">
                        Решение эскалации
                    </h4>
                    <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-full transition-colors">
                        <X className="w-4 h-4 text-gray-400" />
                    </button>
                </div>

                <div className="space-y-3">
                    {/* Resolution type */}
                    <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Тип решения</label>
                        <div className="space-y-1">
                            {RESOLUTION_TYPES.map((r) => (
                                <label
                                    key={r.value}
                                    className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                                        resolutionType === r.value
                                            ? 'bg-blue-50 border border-blue-200'
                                            : 'bg-gray-50 border border-transparent hover:bg-gray-100'
                                    }`}
                                >
                                    <input
                                        type="radio"
                                        name="resolutionType"
                                        value={r.value}
                                        checked={resolutionType === r.value}
                                        onChange={() => setResolutionType(r.value)}
                                        className="w-4 h-4 text-blue-600 accent-blue-600"
                                    />
                                    <span className="text-[13px] text-gray-800">{r.label}</span>
                                </label>
                            ))}
                        </div>
                    </div>

                    {/* Root cause */}
                    <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Причина проблемы</label>
                        <select
                            value={rootCause}
                            onChange={(e) => setRootCause(e.target.value)}
                            className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-[13px] outline-none focus:border-blue-500 transition-colors appearance-none"
                        >
                            <option value="">Выберите причину...</option>
                            {ROOT_CAUSES.map((r) => (
                                <option key={r.value} value={r.value}>{r.label}</option>
                            ))}
                        </select>
                    </div>

                    {/* Comment */}
                    <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Комментарий</label>
                        <textarea
                            value={comment}
                            onChange={(e) => setComment(e.target.value.slice(0, 500))}
                            placeholder="Необязательно..."
                            className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-[13px] outline-none focus:border-blue-500 transition-colors h-16 resize-none"
                        />
                    </div>
                </div>

                <div className="flex gap-2 pt-1">
                    <button
                        onClick={onClose}
                        className="flex-1 py-2.5 rounded-lg bg-gray-50 text-gray-600 text-[13px] font-semibold hover:bg-gray-100 transition-colors"
                    >
                        Отмена
                    </button>
                    <button
                        onClick={() => onConfirm({
                            taskId,
                            resolutionType: resolutionType as 'contacted' | 'reassigned' | 'closed',
                            rootCause,
                            comment,
                        })}
                        disabled={!rootCause || isSaving}
                        className="flex-[2] py-2.5 rounded-lg bg-green-600 text-white text-[13px] font-semibold hover:bg-green-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isSaving ? 'Сохранение...' : 'Подтвердить'}
                    </button>
                </div>
            </div>
        </div>
    )
}
