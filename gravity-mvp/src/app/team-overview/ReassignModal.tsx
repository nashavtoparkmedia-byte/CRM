'use client'

import { useState, useEffect } from 'react'
import { X, Check, Loader2, ArrowRight, AlertTriangle } from 'lucide-react'
import { getManagerActiveTasks } from './actions'
import { getScenario, getStage } from '@/lib/tasks/scenario-config'

interface ReassignableTask {
    id: string
    title: string
    driverName: string
    scenario: string | null
    stage: string | null
    priority: string
    dueAt: string | null
    isOverdue: boolean
}

interface Manager {
    managerId: string
    managerName: string
}

interface ReassignModalProps {
    sourceManager: Manager
    allManagers: Manager[]
    onClose: () => void
    onDone: () => void
}

export default function ReassignModal({ sourceManager, allManagers, onClose, onDone }: ReassignModalProps) {
    const [tasks, setTasks] = useState<ReassignableTask[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [targetId, setTargetId] = useState('')
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [result, setResult] = useState<{ reassigned: number } | null>(null)
    const [error, setError] = useState<string | null>(null)

    // Load tasks for source manager
    useEffect(() => {
        setIsLoading(true)
        getManagerActiveTasks(sourceManager.managerId)
            .then(setTasks)
            .finally(() => setIsLoading(false))
    }, [sourceManager.managerId])

    const otherManagers = allManagers.filter(m => m.managerId !== sourceManager.managerId)

    const toggleTask = (id: string) => {
        setSelected(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const toggleAll = () => {
        if (selected.size === tasks.length) {
            setSelected(new Set())
        } else {
            setSelected(new Set(tasks.map(t => t.id)))
        }
    }

    const handleSubmit = async () => {
        if (selected.size === 0 || !targetId) return
        setIsSubmitting(true)
        setError(null)
        try {
            const res = await fetch('/api/tasks/reassign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    taskIds: Array.from(selected),
                    newAssigneeId: targetId,
                }),
            })
            const data = await res.json()
            if (!res.ok) {
                setError(data.error || 'Ошибка передачи')
                return
            }
            setResult({ reassigned: data.reassigned })
        } catch (err: any) {
            setError(err.message || 'Ошибка сети')
        } finally {
            setIsSubmitting(false)
        }
    }

    // Result screen
    if (result) {
        const targetName = otherManagers.find(m => m.managerId === targetId)?.managerName || ''
        return (
            <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
                <div className="absolute inset-0 bg-black/40" />
                <div className="relative bg-white rounded-xl w-[400px] p-6" onClick={e => e.stopPropagation()}>
                    <div className="text-center">
                        <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
                            <Check className="w-6 h-6 text-green-600" />
                        </div>
                        <h3 className="text-[17px] font-semibold text-[#111827] mb-2">Задачи переданы</h3>
                        <p className="text-[14px] text-[#374151] mb-1">
                            Передано: <span className="font-semibold text-green-600">{result.reassigned}</span>
                        </p>
                        <p className="text-[13px] text-[#94A3B8] mb-4">
                            {sourceManager.managerName} → {targetName}
                        </p>
                        <button
                            onClick={() => { onDone(); onClose() }}
                            className="px-4 py-2 rounded-lg bg-[#4f46e5] text-white text-[14px] font-medium hover:bg-[#4338ca] transition-colors"
                        >
                            Закрыть
                        </button>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
            <div className="absolute inset-0 bg-black/40" />
            <div
                className="relative bg-white rounded-xl w-[520px] max-h-[80vh] flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-[#e5e7eb]">
                    <div>
                        <h3 className="text-[17px] font-semibold text-[#111827]">Передать задачи</h3>
                        <p className="text-[13px] text-[#94A3B8] mt-0.5">От: {sourceManager.managerName}</p>
                    </div>
                    <button onClick={onClose} className="p-1 rounded-lg hover:bg-[#f3f4f6] transition-colors">
                        <X className="w-4 h-4 text-[#6b7280]" />
                    </button>
                </div>

                {/* Target manager selector */}
                <div className="px-5 py-3 border-b border-[#f3f4f6]">
                    <label className="text-[13px] font-medium text-[#374151] mb-1.5 block">Кому передать</label>
                    <select
                        value={targetId}
                        onChange={e => setTargetId(e.target.value)}
                        className="w-full h-[40px] px-3 rounded-lg border border-[#e5e7eb] text-[14px] focus:outline-none focus:border-[#4f46e5] transition-colors"
                    >
                        <option value="">Выберите менеджера...</option>
                        {otherManagers.map(m => (
                            <option key={m.managerId} value={m.managerId}>{m.managerName}</option>
                        ))}
                    </select>
                </div>

                {/* Task list */}
                <div className="flex-1 overflow-y-auto px-5 py-3 min-h-[120px]">
                    {isLoading ? (
                        <div className="flex items-center justify-center py-8">
                            <Loader2 className="w-5 h-5 animate-spin text-[#94A3B8]" />
                        </div>
                    ) : tasks.length === 0 ? (
                        <p className="text-[13px] text-[#94A3B8] text-center py-8">Нет активных задач</p>
                    ) : (
                        <>
                            {/* Select all */}
                            <button
                                onClick={toggleAll}
                                className="text-[12px] font-medium text-[#4f46e5] hover:underline mb-2"
                            >
                                {selected.size === tasks.length ? 'Снять все' : `Выбрать все (${tasks.length})`}
                            </button>

                            <div className="space-y-1">
                                {tasks.map(task => {
                                    const isChecked = selected.has(task.id)
                                    const scenarioLabel = task.scenario ? getScenario(task.scenario)?.label : null
                                    const stageLabel = task.scenario && task.stage ? getStage(task.scenario, task.stage)?.label : null

                                    return (
                                        <button
                                            key={task.id}
                                            onClick={() => toggleTask(task.id)}
                                            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors ${
                                                isChecked ? 'bg-indigo-50 border border-indigo-200' : 'hover:bg-[#f9fafb] border border-transparent'
                                            }`}
                                        >
                                            <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                                                isChecked ? 'bg-[#4f46e5] border-[#4f46e5]' : 'border-[#d1d5db]'
                                            }`}>
                                                {isChecked && <Check className="w-3 h-3 text-white" />}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-1.5">
                                                    <span className="text-[13px] font-medium text-[#111827] truncate">{task.driverName}</span>
                                                    {task.priority === 'high' && (
                                                        <AlertTriangle className="w-3 h-3 text-orange-500 shrink-0" />
                                                    )}
                                                    {task.isOverdue && (
                                                        <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded bg-red-100 text-red-600 shrink-0">
                                                            Просроч
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-1.5 mt-0.5">
                                                    <span className="text-[11px] text-[#64748B] truncate">{task.title}</span>
                                                    {scenarioLabel && (
                                                        <span className="shrink-0 px-1 py-0.5 rounded text-[9px] font-semibold bg-indigo-50 text-indigo-600">
                                                            {scenarioLabel}
                                                            {stageLabel && <> · {stageLabel}</>}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            {task.dueAt && (
                                                <span className={`text-[11px] shrink-0 ${task.isOverdue ? 'text-red-500' : 'text-[#94A3B8]'}`}>
                                                    {new Date(task.dueAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                                                </span>
                                            )}
                                        </button>
                                    )
                                })}
                            </div>
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className="px-5 py-3 border-t border-[#e5e7eb] flex items-center justify-between">
                    {error && <p className="text-[12px] text-red-600 flex-1 mr-2">{error}</p>}
                    <div className="flex items-center gap-2 ml-auto">
                        <button
                            onClick={onClose}
                            className="px-3 py-2 rounded-lg text-[13px] font-medium text-[#374151] hover:bg-[#f3f4f6] transition-colors"
                        >
                            Отмена
                        </button>
                        <button
                            onClick={handleSubmit}
                            disabled={selected.size === 0 || !targetId || isSubmitting}
                            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#4f46e5] text-white text-[13px] font-semibold hover:bg-[#4338ca] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isSubmitting ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <ArrowRight className="w-4 h-4" />
                            )}
                            Передать {selected.size > 0 ? `(${selected.size})` : ''}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
