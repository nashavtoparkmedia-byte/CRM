'use client'

import { User, Phone, MessageSquare } from 'lucide-react'

interface DriverContactCardProps {
    driverName: string
    driverPhone: string | null
    driverId: string
    onCall: () => void
    onWrite: () => void
    onOpenChat: () => void
}

export default function DriverContactCard({
    driverName,
    driverPhone,
    driverId,
    onCall,
    onWrite,
    onOpenChat,
}: DriverContactCardProps) {
    return (
        <div className="mt-4">
            <h4 className="text-section-label mb-2">Связаться</h4>
            <div className="bg-[#FAFAFA] border border-[#F0F0F0] rounded-[12px] p-4">
                <div className="flex items-center gap-3 truncate">
                    <div className="w-9 h-9 rounded-full bg-gray-50 border border-gray-100 flex items-center justify-center shrink-0">
                        <User className="w-5 h-5 text-gray-400" />
                    </div>
                    <div className="flex flex-col min-w-0">
                        <span style={{ fontSize: '15px', fontWeight: 500 }} className="truncate leading-tight text-[#111827]">{driverName}</span>
                        {driverPhone && <span className="text-secondary-value mt-0.5 leading-none">+{driverPhone}</span>}
                    </div>
                </div>

                <div className="flex gap-2 mt-3">
                    <button
                        onClick={onCall}
                        className="flex-1 py-2 px-3 bg-white border border-[#E5E7EB] text-[#374151] font-medium rounded-[8px] hover:bg-gray-50 transition-all flex items-center justify-center gap-2 text-[12px]"
                    >
                        <Phone size={14} className="text-gray-400" /> Позвонить
                    </button>
                    <button
                        onClick={onWrite}
                        className="flex-1 py-2 px-3 bg-white border border-[#E5E7EB] text-[#374151] font-medium rounded-[8px] hover:bg-gray-50 transition-all flex items-center justify-center gap-2 text-[12px]"
                    >
                        <MessageSquare size={14} className="text-gray-400" /> Написать
                    </button>
                    <button
                        onClick={onOpenChat}
                        className="flex-1 py-2 px-3 bg-white border border-[#E5E7EB] text-[#374151] font-medium rounded-[8px] hover:bg-gray-50 transition-all flex items-center justify-center gap-2 text-[12px]"
                    >
                        <MessageSquare size={14} className="text-gray-400" /> Чат
                    </button>
                </div>
            </div>
        </div>
    )
}
