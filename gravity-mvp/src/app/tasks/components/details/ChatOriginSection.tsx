'use client'

import { MessageSquare, ArrowUpRight } from 'lucide-react'
import Link from 'next/link'

interface ChatOriginSectionProps {
    chatId: string
    originMessageId: string | null
    originExcerpt: string | null
}

export default function ChatOriginSection({ chatId, originMessageId, originExcerpt }: ChatOriginSectionProps) {
    return (
        <div className="border border-[#e5e7eb] rounded-xl p-3">
            <div className="flex items-center gap-2 mb-2">
                <MessageSquare className="w-3.5 h-3.5 text-[#94A3B8]" />
                <span className="text-section-label">
                    Связанный чат
                </span>
            </div>
            {originExcerpt && (
                <p className="text-meta !text-[#94A3B8] italic mb-2 line-clamp-2">
                    «{originExcerpt}»
                </p>
            )}
            <div className="flex gap-2">
                <Link
                    href={`/messages?id=${chatId}`}
                    className="flex items-center gap-1 text-meta !text-[#4F46E5] hover:!text-[#4338ca] transition-colors"
                >
                    <ArrowUpRight className="w-3 h-3" />
                    Открыть чат
                </Link>
                {originMessageId && (
                    <Link
                        href={`/messages?id=${chatId}&msg=${originMessageId}`}
                        className="flex items-center gap-1 text-meta !text-[#64748B] hover:!text-[#4F46E5] transition-colors"
                    >
                        К сообщению
                    </Link>
                )}
            </div>
        </div>
    )
}
