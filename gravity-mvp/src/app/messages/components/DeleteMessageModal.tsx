"use client"

import { useState } from "react"

export default function DeleteMessageModal({
    onConfirm,
    onClose,
    contactName,
}: {
    onConfirm: (deleteForEveryone: boolean) => void
    onClose: () => void
    contactName?: string
}) {
    const [deleteForEveryone, setDeleteForEveryone] = useState(true)

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
            onClick={onClose}
        >
            <div
                className="bg-white rounded-2xl w-[320px] overflow-hidden shadow-xl"
                onClick={e => e.stopPropagation()}
            >
                {/* Content */}
                <div className="px-6 pt-5 pb-5">
                    <h3 className="text-[17px] font-semibold text-[#0F172A]">Удалить сообщение</h3>

                    <button
                        onClick={() => setDeleteForEveryone(v => !v)}
                        className="flex items-center gap-3 mt-4 cursor-pointer w-full text-left"
                    >
                        <div className={`w-5 h-5 rounded flex items-center justify-center transition-colors shrink-0 ${
                            deleteForEveryone ? 'bg-[#3390EC]' : 'border-2 border-gray-300'
                        }`}>
                            {deleteForEveryone && (
                                <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
                                    <path d="M1.5 4.5L4 7L9.5 1.5" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            )}
                        </div>
                        <span className="text-[15px] text-[#0F172A]">
                            Удалить для всех
                        </span>
                    </button>
                </div>

                {/* Divider */}
                <div className="h-px bg-[#E4ECFC]" />

                {/* Buttons */}
                <div className="flex">
                    <button
                        onClick={onClose}
                        className="flex-1 py-3.5 text-[15px] font-medium text-[#64748B] hover:bg-[#F8FAFC] transition-colors"
                    >
                        Отмена
                    </button>
                    <div className="w-px bg-[#E4ECFC]" />
                    <button
                        onClick={() => onConfirm(deleteForEveryone)}
                        className="flex-1 py-3.5 text-[15px] font-semibold text-[#DC2626] hover:bg-[#FEF2F2] transition-colors"
                    >
                        Удалить
                    </button>
                </div>
            </div>
        </div>
    )
}
