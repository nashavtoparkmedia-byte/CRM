"use client"

import { useMemo } from "react"
import { Zap } from "lucide-react"

interface QuickReplyTemplate {
    id: string
    name: string
    text: string
    group: string
}

interface QuickReplySuggestionsProps {
    inputText: string
    templates: QuickReplyTemplate[]
    selectedIndex: number
    onSelect: (text: string) => void
    visible: boolean
}

export default function QuickReplySuggestions({ 
    inputText, 
    templates, 
    selectedIndex, 
    onSelect,
    visible 
}: QuickReplySuggestionsProps) {
    const matches = useMemo(() => {
        if (!inputText || inputText.length < 2) return []
        const query = inputText.toLowerCase()
        return templates
            .filter(t => 
                t.name.toLowerCase().includes(query) || 
                t.text.toLowerCase().includes(query)
            )
            .slice(0, 6)
    }, [inputText, templates])

    if (!visible || matches.length === 0) return null

    return (
        <div className="absolute bottom-full left-0 right-0 mb-1 z-50 animate-in fade-in slide-in-from-bottom-1 duration-150">
            <div className="mx-2 bg-white rounded-xl shadow-xl border border-[#E0E0E0] overflow-hidden">
                <div className="px-3 py-1.5 border-b border-[#E8E8E8] flex items-center gap-1.5">
                    <Zap size={10} className="text-amber-500" />
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Быстрые ответы</span>
                </div>
                <div className="py-0.5 max-h-[240px] overflow-y-auto custom-scrollbar">
                    {matches.map((template, idx) => (
                        <button
                            key={template.id}
                            onClick={() => onSelect(template.text)}
                            className={`w-full px-3 py-2 text-left hover:bg-gray-50 transition-colors flex flex-col gap-0.5 ${
                                idx === selectedIndex ? 'bg-[#3390EC]/5' : ''
                            }`}
                        >
                            <div className="flex items-center gap-2">
                                <span className="text-[12px] font-semibold text-[#111]">{template.name}</span>
                                <span className="text-[9px] text-gray-400 bg-gray-100 px-1.5 py-px rounded">{template.group}</span>
                            </div>
                            <span className="text-[11px] text-gray-500 truncate leading-tight">{template.text}</span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    )
}

export type { QuickReplyTemplate }
