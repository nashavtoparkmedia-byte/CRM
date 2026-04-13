'use client'

import { X } from 'lucide-react'

interface ContactResultModalProps {
    isEditing: boolean
    resultId: string
    comment: string
    isSaving: boolean
    contactResults: { id: string; label: string }[]
    onResultChange: (value: string) => void
    onCommentChange: (value: string) => void
    onSave: () => void
    onClose: () => void
}

export default function ContactResultModal({
    isEditing,
    resultId,
    comment,
    isSaving,
    contactResults,
    onResultChange,
    onCommentChange,
    onSave,
    onClose,
}: ContactResultModalProps) {
    return (
        <div className="absolute inset-0 z-50 bg-white/95 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-200">
            <div className="w-full max-w-[320px] bg-white rounded-2xl shadow-2xl border border-gray-100 p-5 space-y-4">
                <div className="flex items-center justify-between">
                    <h4 className="text-[15px] font-bold text-gray-900">
                        {isEditing ? 'Исправление результата' : 'Результат контакта'}
                    </h4>
                    <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-full transition-colors">
                        <X className="w-4 h-4 text-gray-400" />
                    </button>
                </div>

                <div className="space-y-3">
                    <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Результат</label>
                        <select
                            value={resultId}
                            onChange={(e) => onResultChange(e.target.value)}
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-[13px] outline-none focus:border-blue-500 transition-colors cursor-pointer"
                        >
                            <option value="">Выберите...</option>
                            {contactResults.map((r) => (
                                <option key={r.id} value={r.id}>{r.label}</option>
                            ))}
                        </select>
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Комментарий</label>
                        <textarea
                            value={comment}
                            onChange={(e) => onCommentChange(e.target.value.slice(0, 200))}
                            placeholder="Кратко о главном..."
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-[13px] outline-none focus:border-blue-500 transition-colors h-20 resize-none"
                        />
                        <div className="text-[10px] text-right text-gray-400">{comment.length}/200</div>
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
                        onClick={onSave}
                        disabled={!resultId || isSaving}
                        className="flex-2 py-2.5 rounded-xl bg-blue-600 text-white text-[13px] font-bold hover:bg-blue-700 transition-all shadow-md shadow-blue-200 disabled:opacity-50 disabled:shadow-none"
                    >
                        {isSaving ? 'Сохранение...' : 'Зафиксировать'}
                    </button>
                </div>
            </div>
        </div>
    )
}
