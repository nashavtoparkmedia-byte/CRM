"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Reply, Copy, ClipboardList, ChevronRight } from "lucide-react"
import { Message } from "../hooks/useMessages"

const QUICK_EMOJIS = ["👍", "❤️", "🔥", "😂", "😮", "😢"]
const EXTENDED_EMOJIS = [
    "👎", "🎉", "🤔", "🙏", "👀", "💯",
    "😍", "🤣", "😎", "🥺", "😡", "💀",
    "🙌", "✅", "❌", "⚡", "💪", "🫡",
    "🤝"
]

interface MessageContextMenuProps {
    msg: Message
    x: number
    y: number
    onClose: () => void
    onReply?: (msg: Message) => void
    onCreateTask?: (msg: Message) => void
    onReaction?: (msgId: string, emoji: string) => void
}

export default function MessageContextMenu({
    msg, x, y, onClose, onReply, onCreateTask, onReaction
}: MessageContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null)
    const [showExtended, setShowExtended] = useState(false)

    // Position adjustment to keep menu in viewport
    useEffect(() => {
        const el = menuRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        if (rect.right > window.innerWidth - 8) {
            el.style.left = `${x - rect.width}px`
        }
        if (rect.bottom > window.innerHeight - 8) {
            el.style.top = `${y - rect.height}px`
        }
    }, [x, y, showExtended])

    // Close on click outside or Escape
    const handleClickOutside = useCallback((e: MouseEvent) => {
        if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
            onClose()
        }
    }, [onClose])

    useEffect(() => {
        document.addEventListener("mousedown", handleClickOutside)
        document.addEventListener("contextmenu", handleClickOutside)
        const handleEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
        document.addEventListener("keydown", handleEsc)
        return () => {
            document.removeEventListener("mousedown", handleClickOutside)
            document.removeEventListener("contextmenu", handleClickOutside)
            document.removeEventListener("keydown", handleEsc)
        }
    }, [handleClickOutside, onClose])

    const reactions = (msg.metadata?.reactions as Record<string, number>) || {}

    const renderEmoji = (emoji: string) => {
        const isActive = !!reactions[emoji]
        return (
            <button
                key={emoji}
                onClick={() => { onReaction?.(msg.id, emoji); onClose() }}
                className={`w-[34px] h-[34px] rounded-lg text-[19px] flex items-center justify-center transition-all hover:scale-125 hover:bg-gray-100 ${
                    isActive ? 'bg-[#3390EC]/10 scale-110' : ''
                }`}
            >
                {emoji}
            </button>
        )
    }

    const actions = [
        { icon: Reply, label: "Ответить", action: () => { onReply?.(msg); onClose() }, show: !!onReply },
        { icon: Copy, label: "Копировать", action: () => { navigator.clipboard.writeText(msg.content); onClose() }, show: true },
        { icon: ClipboardList, label: "Создать задачу", action: () => { onCreateTask?.(msg); onClose() }, show: !!onCreateTask },
    ].filter(a => a.show)

    return (
        <div
            ref={menuRef}
            className="fixed z-[100] animate-in fade-in zoom-in-95 duration-100"
            style={{ left: x, top: y }}
        >
            <div className="bg-white rounded-xl shadow-2xl border border-gray-200/80 overflow-hidden min-w-[200px]">
                {/* Emoji row */}
                <div className="border-b border-gray-100">
                    {showExtended ? (
                        <div className="px-2 py-2 grid grid-cols-6 gap-0.5">
                            {[...QUICK_EMOJIS, ...EXTENDED_EMOJIS].map(renderEmoji)}
                        </div>
                    ) : (
                        <div className="flex items-center px-1.5 py-1.5">
                            {QUICK_EMOJIS.map(renderEmoji)}
                            <button
                                onClick={() => setShowExtended(true)}
                                className="w-[34px] h-[34px] rounded-lg flex items-center justify-center transition-all hover:bg-gray-100 text-gray-400"
                            >
                                <ChevronRight size={16} />
                            </button>
                        </div>
                    )}
                </div>

                {/* Action items */}
                <div className="py-1">
                    {actions.map((a, i) => (
                        <button
                            key={i}
                            onClick={a.action}
                            className="w-full px-3 py-2 text-left text-[13px] text-[#111] hover:bg-gray-50 transition-colors flex items-center gap-2.5"
                        >
                            <a.icon size={16} className="text-gray-400" />
                            {a.label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    )
}
