'use client'

import { useState, useEffect } from 'react'
import {
    X,
    MessageSquare,
    AlertTriangle,
    Calendar,
    Loader2
} from 'lucide-react'
import { useCreateTask } from '@/hooks/use-task-mutations'
import { checkSimilarTasks } from '@/app/tasks/actions'
import type { TaskPriority, TaskSource, SimilarTaskHint } from '@/lib/tasks/types'
import { SCENARIOS, getAllScenarioOptions } from '@/lib/tasks/scenario-config'

interface TaskCreateModalProps {
    driverId: string
    driverName: string
    source?: TaskSource
    chatContext?: {
        chatId: string
        messageId?: string
        excerpt?: string
        createdAt?: string
    }
    onClose: () => void
}

const TASK_TYPES = [
    { value: 'check_docs', label: 'Проверка документов' },
    { value: 'call_back', label: 'Перезвонить' },
    { value: 'inactive_followup', label: 'Узнать почему не работает' },
    { value: 'payment_issue', label: 'Проблема с выплатой' },
    { value: 'other', label: 'Другое' },
]

export default function TaskCreateModal({
    driverId,
    driverName,
    source = 'manual',
    chatContext,
    onClose
}: TaskCreateModalProps) {
    const createTask = useCreateTask()

    // Form state
    const [scenario, setScenario] = useState<string>('')  // '' = без сценария
    const [title, setTitle] = useState('')
    const [type, setType] = useState('call_back')
    const [description, setDescription] = useState('')
    const [priority, setPriority] = useState<TaskPriority>('medium')
    const [dueDate, setDueDate] = useState('')
    const [createError, setCreateError] = useState<string | null>(null)

    // Dedupe hints
    const [similarTasks, setSimilarTasks] = useState<SimilarTaskHint[]>([])
    const [isCheckingDedupe, setIsCheckingDedupe] = useState(false)

    const scenarioOptions = getAllScenarioOptions()

    // Check for similar tasks on type change
    useEffect(() => {
        let isMounted = true
        async function check() {
            try {
                setIsCheckingDedupe(true)
                const hints = await checkSimilarTasks(driverId, type)
                if (isMounted) setSimilarTasks(hints)
            } catch (err) {
                console.error('Dedupe check failed', err)
            } finally {
                if (isMounted) setIsCheckingDedupe(false)
            }
        }
        check()
        return () => { isMounted = false }
    }, [driverId, type])

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        setCreateError(null)

        const scenarioConfig = scenario ? SCENARIOS[scenario] : null
        const finalTitle = title.trim()
            || scenarioConfig?.label
            || TASK_TYPES.find(t => t.value === type)?.label
            || 'Новая задача'
        const finalType = scenario || type

        let dueAt: string | undefined = undefined
        if (dueDate) {
            const d = new Date(dueDate)
            if (!isNaN(d.getTime())) {
                dueAt = d.toISOString()
            }
        }

        createTask.mutate({
            driverId,
            source: chatContext ? 'chat' : source,
            type: finalType,
            title: finalTitle,
            description: description.trim() || undefined,
            priority,
            dueAt,
            chatId: chatContext?.chatId,
            originMessageId: chatContext?.messageId,
            originExcerpt: chatContext?.excerpt,
            originCreatedAt: chatContext?.createdAt,
            scenario: scenario || undefined,
            stage: scenarioConfig?.initialStage,
        }, {
            onSuccess: () => {
                onClose()
            },
            onError: (err: any) => {
                setCreateError(err?.message || 'Не удалось создать задачу')
            },
        })
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-[#e5e7eb] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-[#f0f0f0]">
                    <div>
                        <h2 className="text-[17px] font-bold text-[#1f2937]">Новая задача</h2>
                        <p className="text-[13px] text-[#6b7280]">Для: <span className="font-semibold text-[#374151]">{driverName}</span></p>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-lg hover:bg-[#f3f4f6] transition-colors text-[#9ca3af]"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-5">
                    <form id="task-form" onSubmit={handleSubmit} className="space-y-4">

                        {/* Scenario selector */}
                        <div>
                            <label className="block text-[12px] font-semibold text-[#374151] mb-1.5 uppercase tracking-wider">
                                Сценарий
                            </label>
                            <select
                                value={scenario}
                                onChange={(e) => {
                                    setScenario(e.target.value)
                                    setCreateError(null)
                                }}
                                className="w-full h-[38px] bg-[#f9fafb] border border-[#d1d5db] rounded-lg px-3 text-[14px] outline-none focus:border-[#4f46e5]"
                            >
                                <option value="">Без сценария</option>
                                {scenarioOptions.map(s => (
                                    <option key={s.value} value={s.value}>{s.label}</option>
                                ))}
                            </select>
                        </div>

                        {/* Error from server (e.g. duplicate scenario) */}
                        {createError && (
                            <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex gap-3 animate-in fade-in">
                                <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
                                <p className="text-[13px] text-red-800">{createError}</p>
                            </div>
                        )}

                        {/* Type — only for non-scenario tasks */}
                        {!scenario && (
                        <div>
                            <label className="block text-[12px] font-semibold text-[#374151] mb-1.5 uppercase tracking-wider">
                                Тип
                            </label>
                            <select
                                value={type}
                                onChange={(e) => setType(e.target.value)}
                                className="w-full h-[38px] bg-[#f9fafb] border border-[#d1d5db] rounded-lg px-3 text-[14px] outline-none focus:border-[#4f46e5]"
                            >
                                {TASK_TYPES.map(t => (
                                    <option key={t.value} value={t.value}>{t.label}</option>
                                ))}
                            </select>
                        </div>
                        )}

                        {/* Dedupe Warning */}
                        {similarTasks.length > 0 && (
                            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex gap-3 animate-in fade-in slide-in-from-top-2">
                                <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
                                <div className="min-w-0">
                                    <p className="text-[13px] font-semibold text-amber-800">
                                        Найдено {similarTasks.length} похожих активных задач
                                    </p>
                                    <div className="mt-1 space-y-1">
                                        {similarTasks.map(st => (
                                            <p key={st.id} className="text-[12px] text-amber-700 truncate">
                                                • {st.title}
                                            </p>
                                        ))}
                                    </div>
                                    <p className="text-[12px] text-amber-700 mt-1 italic">
                                        Вы уверены, что хотите создать еще одну?
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Title */}
                        <div>
                            <label className="block text-[12px] font-semibold text-[#374151] mb-1.5 uppercase tracking-wider">
                                Заголовок
                            </label>
                            <input
                                autoFocus
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="Что нужно сделать?"
                                className="w-full h-[38px] bg-[#f9fafb] border border-[#d1d5db] rounded-lg px-3 text-[14px] outline-none focus:border-[#4f46e5] placeholder:text-[#9ca3af]"
                            />
                        </div>

                        {/* Priorities Grid */}
                        <div>
                            <label className="block text-[12px] font-semibold text-[#374151] mb-1.5 uppercase tracking-wider">
                                Приоритет
                            </label>
                            <div className="grid grid-cols-2 gap-2">
                                {(
                                    [
                                        { val: 'high', label: 'Высокий', color: 'text-orange-700 bg-orange-50 border-orange-200 hover:bg-orange-100', active: 'border-orange-500 ring-2 ring-orange-200' },
                                        { val: 'medium', label: 'Обычный', color: 'text-blue-700 bg-blue-50 border-blue-200 hover:bg-blue-100', active: 'border-blue-500 ring-2 ring-blue-200' },
                                    ] as const
                                ).map(p => (
                                    <button
                                        key={p.val}
                                        type="button"
                                        onClick={() => setPriority(p.val as TaskPriority)}
                                        className={`flex flex-col items-center justify-center p-2 rounded-lg border transition-all ${p.color} ${priority === p.val ? p.active : 'opacity-70'}`}
                                    >
                                        <span className="text-[12px] font-semibold">{p.label}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Due Date */}
                        <div>
                            <label className="flex items-center gap-1 block text-[12px] font-semibold text-[#374151] mb-1.5 uppercase tracking-wider">
                                <Calendar className="w-3.5 h-3.5" />
                                Выполнить до
                            </label>
                            <input
                                type="datetime-local"
                                value={dueDate}
                                onChange={(e) => setDueDate(e.target.value)}
                                className="w-full h-[38px] bg-[#f9fafb] border border-[#d1d5db] rounded-lg px-3 text-[14px] outline-none focus:border-[#4f46e5]"
                            />
                        </div>

                        {/* Description */}
                        <div>
                            <label className="block text-[12px] font-semibold text-[#374151] mb-1.5 uppercase tracking-wider">
                                Подробности (опционально)
                            </label>
                            <textarea
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="Дополнительная информация..."
                                className="w-full h-[80px] py-2 bg-[#f9fafb] border border-[#d1d5db] rounded-lg px-3 text-[14px] outline-none focus:border-[#4f46e5] resize-none"
                            />
                        </div>

                        {/* Chat Context Reference */}
                        {chatContext?.excerpt && (
                            <div className="bg-[#f9fafb] border border-[#e5e7eb] rounded-xl p-3">
                                <div className="flex items-center gap-1.5 mb-1.5">
                                    <MessageSquare className="w-3.5 h-3.5 text-[#6b7280]" />
                                    <span className="text-[11px] font-bold text-[#6b7280] uppercase tracking-wider">Исходное сообщение</span>
                                </div>
                                <p className="text-[12px] text-[#6b7280] italic line-clamp-2">
                                    «{chatContext.excerpt}»
                                </p>
                            </div>
                        )}
                    </form>
                </div>

                {/* Footer */}
                <div className="px-5 py-4 border-t border-[#f0f0f0] bg-[#f9fafb] flex justify-end gap-3">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={createTask.isPending}
                        className="px-4 py-2 rounded-lg text-[14px] font-medium text-[#4b5563] hover:bg-[#e5e7eb] transition-colors"
                    >
                        Отмена
                    </button>
                    <button
                        type="submit"
                        form="task-form"
                        disabled={createTask.isPending}
                        className="flex items-center justify-center gap-2 px-6 py-2 rounded-lg bg-[#4f46e5] hover:bg-[#4338ca] text-white text-[14px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {createTask.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                        Создать задачу
                    </button>
                </div>
            </div>
        </div>
    )
}
