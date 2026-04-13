'use client'

import { Phone, MessageSquare } from 'lucide-react'

interface ContactActionButtonsProps {
    onAction: (type: 'called' | 'wrote') => void
}

export default function ContactActionButtons({ onAction }: ContactActionButtonsProps) {
    return (
        <div className="pt-2 border-t border-gray-100">
            <h4 className="text-section-label mb-2">Действие</h4>
            <div className="flex gap-2">
                <button
                    onClick={() => onAction('called')}
                    className="h-[36px] py-2 px-3 bg-gray-100 border border-gray-200 text-gray-900 font-medium rounded-lg hover:bg-gray-200 transition-all flex items-center justify-center gap-2 text-[14px]"
                >
                    <Phone size={14} className="text-[#64748B]" /> Позвонил
                </button>
                <button
                    onClick={() => onAction('wrote')}
                    className="h-[36px] py-2 px-3 bg-gray-100 border border-gray-200 text-gray-900 font-medium rounded-lg hover:bg-gray-200 transition-all flex items-center justify-center gap-2 text-[14px]"
                >
                    <MessageSquare size={14} className="text-[#64748B]" /> Написал
                </button>
            </div>
        </div>
    )
}
