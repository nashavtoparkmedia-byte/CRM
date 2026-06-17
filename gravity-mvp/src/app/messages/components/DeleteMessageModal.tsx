"use client"

import { useState } from "react"

export default function DeleteMessageModal({
    onConfirm,
    onClose,
}: {
    onConfirm: (deleteForEveryone: boolean) => void
    onClose: () => void
}) {
    const [deleteForEveryone, setDeleteForEveryone] = useState(true)

    return (
        <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40"
            onClick={onClose}
        >
            <div
                className="bg-white rounded-2xl p-6 max-w-[320px] w-full mx-4 flex flex-col gap-4"
                onClick={e => e.stopPropagation()}
            >
                <h3 className="font-semibold text-[17px] text-[#0F172A]">Удалить сообщение</h3>
                <p className="text-[14px] text-[#64748B] leading-snug">
                    Вы уверены, что хотите удалить 1 сообщение?
                </p>

                <button
                    onClick={() => setDeleteForEveryone(v => !v)}
                    className="flex items-center gap-3 cursor-pointer w-fit"
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
                    <span className="text-[14px] text-[#0F172A]">Удалить для всех?</span>
                </button>

                <div className="flex gap-2 mt-1">
                    <button
                        onClick={() => onConfirm(deleteForEveryone)}
                        className="flex-1 h-11 rounded-xl bg-[#DC2626] text-white font-semibold text-[15px] hover:bg-[#B91C1C] transition-colors"
                    >
                        Удалить
                    </button>
                    <button
                        onClick={onClose}
                        className="flex-1 h-11 rounded-xl border border-[#E4ECFC] text-[#64748B] font-medium text-[15px] hover:bg-[#F1F5FD] transition-colors"
                    >
                        Отмена
                    </button>
                </div>
            </div>
        </div>
    )
}
