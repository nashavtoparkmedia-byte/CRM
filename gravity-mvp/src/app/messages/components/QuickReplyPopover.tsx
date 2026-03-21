"use client"

import { useState, useRef, useEffect, useMemo } from "react"
import { X, Search, Plus, Pencil, Trash2, ChevronLeft, Zap } from "lucide-react"
import type { QuickReplyTemplate } from "./QuickReplySuggestions"

interface QuickReplyPopoverProps {
    templates: QuickReplyTemplate[]
    onSelect: (text: string) => void
    onUpdateTemplates: (templates: QuickReplyTemplate[]) => void
    onClose: () => void
}

export default function QuickReplyPopover({ templates, onSelect, onUpdateTemplates, onClose }: QuickReplyPopoverProps) {
    const [searchQuery, setSearchQuery] = useState("")
    const [view, setView] = useState<'list' | 'manage' | 'edit'>('list')
    const [editingTemplate, setEditingTemplate] = useState<QuickReplyTemplate | null>(null)
    const [formName, setFormName] = useState("")
    const [formText, setFormText] = useState("")
    const [formGroup, setFormGroup] = useState("")
    const popoverRef = useRef<HTMLDivElement>(null)
    const searchRef = useRef<HTMLInputElement>(null)

    // Auto-focus search
    useEffect(() => {
        if (view === 'list') setTimeout(() => searchRef.current?.focus(), 50)
    }, [view])

    // Close on outside click
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
                onClose()
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [onClose])

    // Close on Escape
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (view !== 'list') setView('list')
                else onClose()
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [view, onClose])

    // Group templates
    const groups = useMemo(() => {
        const query = searchQuery.toLowerCase()
        const filtered = searchQuery
            ? templates.filter(t => t.name.toLowerCase().includes(query) || t.text.toLowerCase().includes(query) || t.group.toLowerCase().includes(query))
            : templates

        const grouped: Record<string, QuickReplyTemplate[]> = {}
        filtered.forEach(t => {
            const g = t.group || 'Без группы'
            if (!grouped[g]) grouped[g] = []
            grouped[g].push(t)
        })
        return grouped
    }, [templates, searchQuery])

    const handleSelect = (text: string) => {
        onSelect(text)
        onClose()
    }

    const handleStartEdit = (template: QuickReplyTemplate) => {
        setEditingTemplate(template)
        setFormName(template.name)
        setFormText(template.text)
        setFormGroup(template.group)
        setView('edit')
    }

    const handleStartCreate = () => {
        setEditingTemplate(null)
        setFormName("")
        setFormText("")
        setFormGroup("")
        setView('edit')
    }

    const handleSave = () => {
        if (!formName.trim() || !formText.trim()) return

        if (editingTemplate) {
            // Update
            const updated = templates.map(t => 
                t.id === editingTemplate.id 
                    ? { ...t, name: formName.trim(), text: formText.trim(), group: formGroup.trim() || 'Общие' }
                    : t
            )
            onUpdateTemplates(updated)
        } else {
            // Create
            const newTemplate: QuickReplyTemplate = {
                id: `qr-${Date.now()}`,
                name: formName.trim(),
                text: formText.trim(),
                group: formGroup.trim() || 'Общие',
            }
            onUpdateTemplates([...templates, newTemplate])
        }
        setView('manage')
    }

    const handleDelete = (id: string) => {
        onUpdateTemplates(templates.filter(t => t.id !== id))
    }

    // Get unique groups for the form dropdown
    const uniqueGroups = useMemo(() => {
        const gs = new Set(templates.map(t => t.group))
        gs.add('Общие')
        return Array.from(gs)
    }, [templates])

    return (
        <div
            ref={popoverRef}
            className="absolute bottom-full left-0 mb-1.5 w-[300px] bg-white rounded-xl shadow-2xl border border-[#E0E0E0] z-50 animate-in fade-in slide-in-from-bottom-2 duration-150 overflow-hidden"
        >
            {/* LIST VIEW */}
            {view === 'list' && (
                <>
                    <div className="flex items-center justify-between px-3.5 h-[38px] border-b border-[#E8E8E8]">
                        <span className="text-[13px] font-bold text-[#111] flex items-center gap-1.5">
                            <Zap size={13} className="text-amber-500" />
                            Быстрые ответы
                        </span>
                        <button onClick={onClose} className="w-5 h-5 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-700 transition-colors">
                            <X size={12} />
                        </button>
                    </div>

                    <div className="px-3 pt-2.5 pb-1.5">
                        <div className="relative">
                            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                            <input
                                ref={searchRef}
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Поиск шаблона..."
                                className="w-full h-[30px] bg-[#F4F5F7] rounded-lg pl-7 pr-3 text-[12px] outline-none placeholder:text-gray-400 font-medium text-[#111] focus:bg-[#EEF0F3] transition-colors"
                            />
                        </div>
                    </div>

                    <div className="max-h-[240px] overflow-y-auto custom-scrollbar py-0.5">
                        {Object.entries(groups).length === 0 ? (
                            <div className="px-3.5 py-4 text-center text-[12px] text-gray-400">
                                {searchQuery ? "Ничего не найдено" : "Нет шаблонов"}
                            </div>
                        ) : (
                            Object.entries(groups).map(([groupName, items]) => (
                                <div key={groupName}>
                                    <div className="px-3.5 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                                        {groupName}
                                    </div>
                                    {items.map(template => (
                                        <button
                                            key={template.id}
                                            onClick={() => handleSelect(template.text)}
                                            className="w-full px-3.5 py-2 text-left hover:bg-gray-50 transition-colors"
                                        >
                                            <div className="text-[12px] font-medium text-[#111]">{template.name}</div>
                                            <div className="text-[11px] text-gray-500 truncate mt-0.5 leading-tight">{template.text}</div>
                                        </button>
                                    ))}
                                </div>
                            ))
                        )}
                    </div>

                    <div className="px-3 py-2 border-t border-[#E8E8E8]">
                        <button
                            onClick={() => setView('manage')}
                            className="w-full h-[30px] text-[11px] text-[#3390EC] font-semibold rounded-lg bg-[#3390EC]/5 hover:bg-[#3390EC]/10 transition-colors flex items-center justify-center gap-1"
                        >
                            Управление шаблонами
                        </button>
                    </div>
                </>
            )}

            {/* MANAGE VIEW */}
            {view === 'manage' && (
                <>
                    <div className="flex items-center justify-between px-3.5 h-[38px] border-b border-[#E8E8E8]">
                        <div className="flex items-center gap-2">
                            <button onClick={() => setView('list')} className="text-gray-400 hover:text-gray-700">
                                <ChevronLeft size={16} />
                            </button>
                            <span className="text-[13px] font-bold text-[#111]">Управление</span>
                        </div>
                        <button onClick={onClose} className="w-5 h-5 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-700 transition-colors">
                            <X size={12} />
                        </button>
                    </div>

                    <div className="max-h-[280px] overflow-y-auto custom-scrollbar py-1">
                        {Object.entries(groups).map(([groupName, items]) => (
                            <div key={groupName}>
                                <div className="px-3.5 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                                    {groupName}
                                </div>
                                {items.map(template => (
                                    <div key={template.id} className="flex items-center px-3.5 py-1.5 hover:bg-gray-50 group">
                                        <div className="flex-1 min-w-0">
                                            <div className="text-[12px] font-medium text-[#111] truncate">{template.name}</div>
                                        </div>
                                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <button 
                                                onClick={() => handleStartEdit(template)}
                                                className="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:text-[#3390EC] hover:bg-[#3390EC]/10 transition-colors"
                                            >
                                                <Pencil size={11} />
                                            </button>
                                            <button 
                                                onClick={() => handleDelete(template.id)}
                                                className="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                                            >
                                                <Trash2 size={11} />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>

                    <div className="px-3 py-2 border-t border-[#E8E8E8]">
                        <button
                            onClick={handleStartCreate}
                            className="w-full h-[30px] text-[11px] text-white font-semibold rounded-lg bg-[#3390EC] hover:bg-[#2B7FD4] transition-colors flex items-center justify-center gap-1"
                        >
                            <Plus size={12} /> Добавить шаблон
                        </button>
                    </div>
                </>
            )}

            {/* EDIT VIEW (create or edit) */}
            {view === 'edit' && (
                <>
                    <div className="flex items-center justify-between px-3.5 h-[38px] border-b border-[#E8E8E8]">
                        <div className="flex items-center gap-2">
                            <button onClick={() => setView('manage')} className="text-gray-400 hover:text-gray-700">
                                <ChevronLeft size={16} />
                            </button>
                            <span className="text-[13px] font-bold text-[#111]">
                                {editingTemplate ? 'Редактирование' : 'Новый шаблон'}
                            </span>
                        </div>
                        <button onClick={onClose} className="w-5 h-5 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-700 transition-colors">
                            <X size={12} />
                        </button>
                    </div>

                    <div className="px-3.5 py-3 space-y-2.5">
                        <div>
                            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1 block">Название</label>
                            <input
                                autoFocus
                                value={formName}
                                onChange={(e) => setFormName(e.target.value)}
                                placeholder="Например: Приветствие"
                                className="w-full h-[32px] bg-[#F4F5F7] rounded-lg px-3 text-[13px] outline-none placeholder:text-gray-400 text-[#111] focus:bg-[#EEF0F3] transition-colors"
                            />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1 block">Текст сообщения</label>
                            <textarea
                                value={formText}
                                onChange={(e) => setFormText(e.target.value)}
                                placeholder="Текст, который будет вставлен..."
                                rows={3}
                                className="w-full bg-[#F4F5F7] rounded-lg px-3 py-2 text-[13px] outline-none placeholder:text-gray-400 text-[#111] resize-none focus:bg-[#EEF0F3] transition-colors"
                            />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1 block">Группа</label>
                            <input
                                value={formGroup}
                                onChange={(e) => setFormGroup(e.target.value)}
                                placeholder="Общие"
                                list="template-groups"
                                className="w-full h-[32px] bg-[#F4F5F7] rounded-lg px-3 text-[13px] outline-none placeholder:text-gray-400 text-[#111] focus:bg-[#EEF0F3] transition-colors"
                            />
                            <datalist id="template-groups">
                                {uniqueGroups.map(g => <option key={g} value={g} />)}
                            </datalist>
                        </div>
                    </div>

                    <div className="px-3.5 pb-3">
                        <button
                            onClick={handleSave}
                            disabled={!formName.trim() || !formText.trim()}
                            className={`w-full h-[34px] text-[13px] font-semibold rounded-lg transition-all flex items-center justify-center ${
                                formName.trim() && formText.trim()
                                    ? 'bg-[#3390EC] text-white hover:bg-[#2B7FD4] active:scale-[0.98]'
                                    : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            }`}
                        >
                            Сохранить
                        </button>
                    </div>
                </>
            )}
        </div>
    )
}
