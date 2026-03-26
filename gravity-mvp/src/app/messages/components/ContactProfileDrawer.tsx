"use client"

import { useState } from "react"
import { X, Phone, UserCheck, ClipboardList, MoreHorizontal, ExternalLink, Plus, Bot, Archive, Ban, ChevronDown, Calendar, Pencil, Trash2, Check } from "lucide-react"
import { useChatNavigation } from "../hooks/useChatNavigation"
import { useConversations } from "../hooks/useConversations"
import DriverTasksWidget from "./DriverTasksWidget"
import TaskCreateModal from "@/app/tasks/components/TaskCreateModal"

// Custom field types
interface CustomField {
    id: string
    label: string
    type: 'text' | 'select' | 'multi-select' | 'date'
    value: string | string[]
    options?: string[]
}

// Default custom fields for demo
const defaultCustomFields: CustomField[] = [
    { id: 'park', label: 'Парк', type: 'select', value: 'Яндекс', options: ['Яндекс', 'Uber', 'Сити Мобил', 'Максим'] },
    { id: 'role', label: 'Роль', type: 'select', value: 'Водитель', options: ['Водитель', 'Курьер', 'Партнёр', 'Стажёр'] },
    { id: 'city', label: 'Город', type: 'text', value: '' },
    { id: 'start_date', label: 'Дата начала', type: 'date', value: '' },
]

export default function ContactProfileDrawer({ chatId }: { chatId: string }) {
    const { toggleProfileDrawer } = useChatNavigation()
    const { conversations } = useConversations()
    const chat = conversations.find(c => c.id === chatId)
    const [tags, setTags] = useState<string[]>([])
    const [tagInput, setTagInput] = useState("")
    const [showTagInput, setShowTagInput] = useState(false)
    const [showMoreMenu, setShowMoreMenu] = useState(false)
    const [customFields, setCustomFields] = useState<CustomField[]>(defaultCustomFields)
    const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
    const [editingFieldValue, setEditingFieldValue] = useState("")
    const [showAddField, setShowAddField] = useState(false)
    const [newFieldLabel, setNewFieldLabel] = useState("")
    const [newFieldType, setNewFieldType] = useState<'text' | 'select' | 'date'>('text')
    const [aiStatus, setAiStatus] = useState<'active' | 'paused' | 'inactive'>('inactive')
    const [isTaskModalOpen, setIsTaskModalOpen] = useState(false)

    if (!chat) return null

    const allChannels = [
        chat.channel === 'whatsapp' && { label: 'WA', color: 'bg-emerald-50 text-emerald-700' },
        chat.channel === 'telegram' && { label: 'TG', color: 'bg-blue-50 text-blue-700' },
        chat.channel === 'max' && { label: 'MAX', color: 'bg-purple-50 text-purple-700' },
    ].filter(Boolean) as { label: string, color: string }[]

    const handleAddTag = () => {
        if (tagInput.trim() && !tags.includes(tagInput.trim())) {
            setTags([...tags, tagInput.trim()])
            setTagInput("")
            setShowTagInput(false)
        }
    }

    const handleRemoveTag = (tag: string) => {
        setTags(tags.filter(t => t !== tag))
    }

    const handleFieldSave = (fieldId: string, newValue: string) => {
        setCustomFields(fields => fields.map(f => f.id === fieldId ? { ...f, value: newValue } : f))
        setEditingFieldId(null)
    }

    const handleFieldDelete = (fieldId: string) => {
        setCustomFields(fields => fields.filter(f => f.id !== fieldId))
    }

    const handleAddField = () => {
        if (!newFieldLabel.trim()) return
        const newField: CustomField = {
            id: `custom-${Date.now()}`,
            label: newFieldLabel.trim(),
            type: newFieldType,
            value: '',
            options: newFieldType === 'select' ? ['Вариант 1', 'Вариант 2'] : undefined,
        }
        setCustomFields([...customFields, newField])
        setNewFieldLabel("")
        setNewFieldType('text')
        setShowAddField(false)
    }

    // Mock task count
    const activeTaskCount = 3

    return (
        <div className="w-[280px] bg-white border-l border-[#E8E8E8] shrink-0 h-full flex flex-col animate-in slide-in-from-right-4 duration-200">
            {/* Header */}
            <div className="h-[44px] border-b border-[#E8E8E8] flex items-center justify-between px-4 shrink-0">
                <span className="text-[13px] font-semibold text-[#111]">Профиль</span>
                <button 
                    onClick={() => toggleProfileDrawer(false)} 
                    className="w-6 h-6 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-700 transition-colors"
                >
                    <X size={14} />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar">
                {/* Contact Card */}
                <div className="px-4 pt-4 pb-3 flex flex-col items-center text-center">
                    <div className="w-14 h-14 rounded-full bg-[#3390EC] text-white flex items-center justify-center text-[20px] font-bold mb-2">
                        {chat.name?.substring(0, 2).toUpperCase() || "DR"}
                    </div>
                    <h3 className="text-[15px] font-semibold text-[#111]">{chat.name || "Водитель"}</h3>
                    {chat.driver?.phone && (
                        <div className="flex items-center gap-1.5 mt-0.5 text-[12px] text-gray-500">
                            <Phone size={11} />
                            {chat.driver.phone}
                        </div>
                    )}
                    <div className="flex items-center gap-1 mt-1.5">
                        {allChannels.map(ch => (
                            <span key={ch.label} className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${ch.color}`}>{ch.label}</span>
                        ))}
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                            chat.status === 'active' ? 'bg-green-50 text-green-700' : 
                            chat.status === 'new' ? 'bg-blue-50 text-blue-700' : 
                            'bg-gray-100 text-gray-600'
                        }`}>
                            {chat.status === 'active' ? 'В работе' : chat.status === 'new' ? 'Новый' : chat.status}
                        </span>
                    </div>
                </div>

                {/* Quick Actions */}
                <div className="px-3 pb-2 flex gap-1.5">
                    <button
                        onClick={() => {
                            if (chat.driver?.id) setIsTaskModalOpen(true)
                        }}
                        className={`flex-1 h-[30px] text-white text-[11px] font-semibold rounded-lg transition-colors flex items-center justify-center gap-1 ${
                            chat.driver?.id ? 'bg-[#3390EC] hover:bg-[#2B7FD4]' : 'bg-gray-300 cursor-not-allowed'
                        }`}
                        title={!chat.driver?.id ? 'Водитель не привязан к чату' : ''}
                    >
                        <ClipboardList size={11} /> Задача
                    </button>
                    <button className="flex-1 h-[30px] bg-gray-100 text-gray-700 text-[11px] font-semibold rounded-lg hover:bg-gray-200 transition-colors flex items-center justify-center gap-1">
                        <UserCheck size={11} /> Назначить
                    </button>
                    <div className="relative">
                        <button 
                            onClick={() => setShowMoreMenu(!showMoreMenu)}
                            className="h-[30px] w-[30px] bg-gray-100 text-gray-500 rounded-lg hover:bg-gray-200 transition-colors flex items-center justify-center"
                        >
                            <MoreHorizontal size={13} />
                        </button>
                        {showMoreMenu && (
                            <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-lg border border-[#E0E0E0] py-1 min-w-[160px] z-50 animate-in fade-in slide-in-from-top-1 duration-150">
                                <button className="w-full px-3 h-[30px] flex items-center gap-2 text-[12px] text-[#111] hover:bg-gray-50">
                                    <ExternalLink size={12} /> Открыть в CRM
                                </button>
                                <button className="w-full px-3 h-[30px] flex items-center gap-2 text-[12px] text-[#111] hover:bg-gray-50">
                                    <Archive size={12} /> Архивировать
                                </button>
                                <div className="h-px bg-[#E8E8E8] mx-2 my-0.5" />
                                <button className="w-full px-3 h-[30px] flex items-center gap-2 text-[12px] text-red-500 hover:bg-red-50">
                                    <Ban size={12} /> Заблокировать
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                <div className="h-px bg-[#E8E8E8] mx-3" />

                {/* Custom Fields */}
                <div className="px-4 py-2.5">
                    <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Поля</h4>
                    <div className="space-y-1.5">
                        {customFields.map(field => (
                            <div key={field.id} className="group flex items-center justify-between min-h-[28px]">
                                <span className="text-[12px] text-gray-500 shrink-0 w-[80px]">{field.label}</span>
                                
                                {editingFieldId === field.id ? (
                                    <div className="flex-1 flex items-center gap-1 ml-2">
                                        {field.type === 'select' && field.options ? (
                                            <select
                                                autoFocus
                                                value={editingFieldValue}
                                                onChange={(e) => setEditingFieldValue(e.target.value)}
                                                onBlur={() => handleFieldSave(field.id, editingFieldValue)}
                                                className="flex-1 h-[24px] bg-[#F4F5F7] rounded px-2 text-[12px] text-[#111] outline-none border border-[#3390EC]/30"
                                            >
                                                {field.options.map(opt => (
                                                    <option key={opt} value={opt}>{opt}</option>
                                                ))}
                                            </select>
                                        ) : field.type === 'date' ? (
                                            <input
                                                type="date"
                                                autoFocus
                                                value={editingFieldValue}
                                                onChange={(e) => setEditingFieldValue(e.target.value)}
                                                onBlur={() => handleFieldSave(field.id, editingFieldValue)}
                                                onKeyDown={(e) => { if (e.key === 'Enter') handleFieldSave(field.id, editingFieldValue); if (e.key === 'Escape') setEditingFieldId(null) }}
                                                className="flex-1 h-[24px] bg-[#F4F5F7] rounded px-2 text-[12px] text-[#111] outline-none border border-[#3390EC]/30"
                                            />
                                        ) : (
                                            <input
                                                type="text"
                                                autoFocus
                                                value={editingFieldValue}
                                                onChange={(e) => setEditingFieldValue(e.target.value)}
                                                onBlur={() => handleFieldSave(field.id, editingFieldValue)}
                                                onKeyDown={(e) => { if (e.key === 'Enter') handleFieldSave(field.id, editingFieldValue); if (e.key === 'Escape') setEditingFieldId(null) }}
                                                placeholder="Введите..."
                                                className="flex-1 h-[24px] bg-[#F4F5F7] rounded px-2 text-[12px] text-[#111] outline-none border border-[#3390EC]/30 placeholder:text-gray-400"
                                            />
                                        )}
                                        <button onClick={() => handleFieldSave(field.id, editingFieldValue)} className="text-[#3390EC]">
                                            <Check size={12} />
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex-1 flex items-center gap-1 ml-2">
                                        <button
                                            onClick={() => { setEditingFieldId(field.id); setEditingFieldValue(typeof field.value === 'string' ? field.value : '') }}
                                            className="flex-1 text-left text-[12px] font-medium text-[#111] hover:text-[#3390EC] transition-colors truncate h-[24px] flex items-center"
                                        >
                                            {field.value || <span className="text-gray-400 italic">—</span>}
                                            {field.type === 'select' && <ChevronDown size={10} className="ml-0.5 text-gray-400" />}
                                        </button>
                                        <button
                                            onClick={() => handleFieldDelete(field.id)}
                                            className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-all"
                                        >
                                            <Trash2 size={10} />
                                        </button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    {/* Add field */}
                    {showAddField ? (
                        <div className="mt-2 bg-[#F4F5F7] rounded-lg p-2.5 space-y-1.5 animate-in fade-in duration-150">
                            <input
                                autoFocus
                                value={newFieldLabel}
                                onChange={(e) => setNewFieldLabel(e.target.value)}
                                placeholder="Название поля..."
                                onKeyDown={(e) => { if (e.key === 'Enter') handleAddField(); if (e.key === 'Escape') setShowAddField(false) }}
                                className="w-full h-[26px] bg-white rounded px-2 text-[12px] outline-none placeholder:text-gray-400 text-[#111]"
                            />
                            <div className="flex gap-1">
                                <select
                                    value={newFieldType}
                                    onChange={(e) => setNewFieldType(e.target.value as any)}
                                    className="flex-1 h-[26px] bg-white rounded px-2 text-[11px] outline-none text-[#111]"
                                >
                                    <option value="text">Текст</option>
                                    <option value="select">Список</option>
                                    <option value="date">Дата</option>
                                </select>
                                <button
                                    onClick={handleAddField}
                                    className="h-[26px] px-2.5 bg-[#3390EC] text-white text-[11px] font-semibold rounded hover:bg-[#2B7FD4] transition-colors"
                                >
                                    Добавить
                                </button>
                            </div>
                        </div>
                    ) : (
                        <button 
                            onClick={() => setShowAddField(true)}
                            className="mt-2 inline-flex items-center gap-0.5 text-[11px] text-[#3390EC] font-medium px-2 py-1 rounded-lg bg-[#3390EC]/5 hover:bg-[#3390EC]/10 transition-colors"
                        >
                            <Plus size={10} /> Добавить поле
                        </button>
                    )}
                </div>

                <div className="h-px bg-[#E8E8E8] mx-3" />

                {/* Tags */}
                <div className="px-4 py-2.5">
                    <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Теги</h4>
                    <div className="flex flex-wrap gap-1">
                        {tags.map(tag => (
                            <span key={tag} className="inline-flex items-center gap-1 bg-gray-100 text-[11px] text-gray-700 px-2 py-0.5 rounded-full">
                                {tag}
                                <button onClick={() => handleRemoveTag(tag)} className="text-gray-400 hover:text-gray-700">
                                    <X size={10} />
                                </button>
                            </span>
                        ))}
                        {showTagInput ? (
                            <input
                                autoFocus
                                value={tagInput}
                                onChange={(e) => setTagInput(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleAddTag(); if (e.key === 'Escape') setShowTagInput(false); }}
                                onBlur={() => { if (!tagInput.trim()) setShowTagInput(false); }}
                                placeholder="Тег..."
                                className="h-[22px] w-[80px] bg-gray-100 rounded-full px-2 text-[11px] outline-none placeholder:text-gray-400"
                            />
                        ) : (
                            <button 
                                onClick={() => setShowTagInput(true)}
                                className="inline-flex items-center gap-0.5 text-[11px] text-[#3390EC] font-medium px-2 py-0.5 rounded-full bg-[#3390EC]/5 hover:bg-[#3390EC]/10 transition-colors"
                            >
                                <Plus size={10} /> Тег
                            </button>
                        )}
                    </div>
                </div>

                <div className="h-px bg-[#E8E8E8] mx-3" />

                {/* Tasks Widget */}
                {chat.driver?.id ? (
                    <DriverTasksWidget driverId={chat.driver.id} />
                ) : (
                    <div className="px-4 py-3">
                        <div className="flex items-center gap-2 mb-2 text-[#9ca3af]">
                            <ClipboardList className="w-4 h-4" />
                            <span className="text-[14px] font-semibold">Задачи</span>
                        </div>
                        <div className="text-[12px] text-[#9ca3af] italic">
                            Водитель не привязан к чату
                        </div>
                    </div>
                )}

                <div className="h-px bg-[#E8E8E8] mx-3" />

                {/* AI Agent */}
                <div className="px-4 py-2.5">
                    <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">AI Агент</h4>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                            <div className={`w-2 h-2 rounded-full ${
                                aiStatus === 'active' ? 'bg-green-500' : 
                                aiStatus === 'paused' ? 'bg-yellow-500' : 'bg-gray-300'
                            }`} />
                            <span className="text-[12px] text-[#111] font-medium">
                                {aiStatus === 'active' ? 'Активен' : aiStatus === 'paused' ? 'Пауза' : 'Неактивен'}
                            </span>
                        </div>
                        <div className="flex items-center gap-1">
                            {aiStatus === 'active' ? (
                                <button 
                                    onClick={() => setAiStatus('paused')}
                                    className="text-[10px] text-yellow-600 font-semibold px-2 py-0.5 bg-yellow-50 rounded hover:bg-yellow-100 transition-colors"
                                >
                                    Пауза
                                </button>
                            ) : (
                                <button 
                                    onClick={() => setAiStatus('active')}
                                    className="text-[10px] text-[#3390EC] font-semibold px-2 py-0.5 bg-[#3390EC]/10 rounded hover:bg-[#3390EC]/20 transition-colors"
                                >
                                    Включить
                                </button>
                            )}
                            {aiStatus !== 'inactive' && (
                                <button 
                                    onClick={() => setAiStatus('inactive')}
                                    className="text-[10px] text-gray-500 font-medium px-2 py-0.5 bg-gray-100 rounded hover:bg-gray-200 transition-colors"
                                >
                                    Взять на себя
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                <div className="h-px bg-[#E8E8E8] mx-3" />

                {/* Context Info */}
                <div className="px-4 py-2.5">
                    <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Контекст</h4>
                    <div className="space-y-2 text-[12px]">
                        <div className="flex justify-between">
                            <span className="text-gray-500">Последний контакт</span>
                            <span className="text-[#111] font-medium">
                                {chat.lastMessageAt ? new Date(chat.lastMessageAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '—'}
                            </span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-gray-500">Ответственный</span>
                            <span className="text-[#3390EC] font-medium cursor-pointer hover:underline">Назначить</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Task Create Modal */}
            {isTaskModalOpen && chat.driver?.id && (
                <TaskCreateModal
                    driverId={chat.driver.id}
                    driverName={chat.name || 'Водитель'}
                    source="chat"
                    chatContext={{ chatId: chat.id }}
                    onClose={() => setIsTaskModalOpen(false)}
                />
            )}
        </div>
    )
}
