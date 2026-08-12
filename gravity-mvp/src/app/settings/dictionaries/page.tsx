'use client'

import { useState, useEffect } from 'react'
import { PageContainer } from '@/infrastructure/ui/PageContainer'
import { PageHeader } from '@/infrastructure/ui/PageHeader'
import type {
    TaskDictionaryItemV1,
    TaskDictionaryTypeV1,
} from '@/contracts/work-management/v1'
import {
    addTaskDictionaryItemV1,
    deleteTaskDictionaryItemV1,
    getTaskDictionariesV1,
    updateTaskDictionaryItemV1,
} from '@/modules/work-management/public/v1/task-dictionary-catalog'
import { getCurrentUserIdentityV1 as getCurrentUser } from '@/modules/identity-access/public/v1/user-directory'
import { Plus, Trash2, Check, X, ToggleLeft, ToggleRight } from 'lucide-react'

const DICT_TITLES: Record<TaskDictionaryTypeV1, string> = {
    scenarios: 'Сценарии',
    events: 'События',
    statuses: 'Статусы',
    priorities: 'Приоритеты',
    sources: 'Источники',
    history_actions: 'Типы действий истории',
    contact_results: 'Результаты контакта',
    next_actions: 'Следующие действия'
}

export default function DictionariesPage() {
    const [dicts, setDicts] = useState<any>(null)
    const [activeTab, setActiveTab] = useState<TaskDictionaryTypeV1>('scenarios')
    const [newLabel, setNewLabel] = useState('')
    const [isLoading, setIsLoading] = useState(true)
    const [currentUser, setCurrentUser] = useState<any>(null)

    const load = () => {
        setIsLoading(true)
        getTaskDictionariesV1().then(res => {
            setDicts(res)
            setIsLoading(false)
        })
    }

    useEffect(() => {
        getCurrentUser().then(setCurrentUser)
        load()
    }, [])

    const handleAdd = async () => {
        if (!newLabel.trim()) return
        await addTaskDictionaryItemV1(activeTab, { label: newLabel, isActive: true })
        setNewLabel('')
        load()
    }

    const handleToggleActive = async (item: TaskDictionaryItemV1) => {
        await updateTaskDictionaryItemV1(activeTab, item.id, { isActive: !item.isActive })
        load()
    }

    const handleDelete = async (id: string) => {
        if (!confirm('Вы уверены?')) return
        await deleteTaskDictionaryItemV1(activeTab, id)
        load()
    }

    if (isLoading && !dicts) return <div className="p-[8px] text-center text-gray-500">Загрузка справочников...</div>

    if (currentUser && currentUser.role === 'Менеджер') {
        return (
            <PageContainer>
                <div className="p-[8px] text-center text-red-500 font-bold bg-red-50 rounded-xl border border-red-200 mt-6 shadow-sm">
                    Доступ запрещен. У вас недостаточно прав для редактирования справочников (разрешено только Руководителям и Администраторам).
                </div>
            </PageContainer>
        )
    }

    return (
        <PageContainer>
            <PageHeader 
                title="Справочники" 
                description="Управление настройками полей CRM без участия разработчика" 
            />

            {/* Tabs grouped into containers */}
            <div className="flex flex-wrap items-center gap-[4px] mt-[8px]">
                {/* Group 1: Operational */}
                <div className="p-1 px-2.5 bg-gray-50/80 rounded-2xl border border-gray-200 flex items-center gap-1 shadow-sm">
                    {['contact_results', 'next_actions'].map(type => (
                        <button
                            key={type}
                            onClick={() => setActiveTab(type as TaskDictionaryTypeV1)}
                            className={`px-[4px] py-1.5 text-[13px] font-bold rounded-xl transition-all whitespace-nowrap ${
                                activeTab === type 
                                    ? 'bg-white text-gray-900 shadow-sm border border-gray-200' 
                                    : 'text-gray-500 hover:text-gray-800'
                            }`}
                        >
                            {DICT_TITLES[type as TaskDictionaryTypeV1]}
                        </button>
                    ))}
                </div>

                {/* Group 2: System */}
                <div className="p-1 px-2.5 bg-gray-50/80 rounded-2xl border border-gray-200 flex items-center gap-1 shadow-sm">
                    {['scenarios', 'events', 'statuses', 'priorities', 'sources', 'history_actions'].map(type => (
                        <button
                            key={type}
                            onClick={() => setActiveTab(type as TaskDictionaryTypeV1)}
                            className={`px-[4px] py-1.5 text-[13px] font-bold rounded-xl transition-all whitespace-nowrap ${
                                activeTab === type 
                                    ? 'bg-white text-gray-900 shadow-sm border border-gray-200' 
                                    : 'text-gray-500 hover:text-gray-800'
                            }`}
                        >
                            {DICT_TITLES[type as TaskDictionaryTypeV1]}
                        </button>
                    ))}
                </div>
            </div>

            <div className="mt-[4px] bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                {/* List Items */}
                <div className="divide-y divide-gray-100">
                    {dicts?.[activeTab]?.map((item: TaskDictionaryItemV1) => (
                        <div key={item.id} className="flex items-center justify-between px-[4px] py-3 hover:bg-gray-50 transition-colors">
                            <div>
                                <span className={`text-[14px] font-medium ${item.isActive ? 'text-gray-900' : 'text-gray-400 line-through'}`}>
                                    {item.label}
                                </span>
                                {item.metadata && Object.keys(item.metadata).length > 0 && (
                                    <span className="ml-[2px] text-[11px] text-gray-400">
                                        ({JSON.stringify(item.metadata)})
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={() => handleToggleActive(item)}
                                    className={`p-1.5 rounded-lg transition-colors ${item.isActive ? 'text-green-600 hover:bg-green-50' : 'text-gray-400 hover:bg-gray-100'}`}
                                    title={item.isActive ? 'Деактивировать' : 'Активировать'}
                                >
                                    {item.isActive ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                                </button>
                                <button
                                    onClick={() => handleDelete(item.id)}
                                    className="p-1.5 rounded-lg text-red-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                                    title="Удалить"
                                >
                                    <Trash2 size={16} />
                                </button>
                            </div>
                        </div>
                    ))}
                    {(!dicts?.[activeTab] || dicts[activeTab].length === 0) && (
                        <div className="p-[8px] text-center text-gray-400 text-sm">Список пуст</div>
                    )}
                </div>

                {/* Add Box */}
                <div className="p-[4px] border-t border-gray-100 bg-gray-50/50 flex gap-[2px]">
                    <input
                        type="text"
                        placeholder="Добавить новую запись..."
                        value={newLabel}
                        onChange={(e) => setNewLabel(e.target.value)}
                        className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-primary transition-colors bg-white font-medium text-gray-900"
                        onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                    />
                    <button
                        onClick={handleAdd}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white rounded-lg text-sm font-semibold hover:bg-primary-hover transition-colors shadow-sm"
                    >
                        <Plus size={16} />
                        Добавить
                    </button>
                </div>
            </div>
        </PageContainer>
    )
}
