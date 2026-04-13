'use client'

import type { TaskDTO } from '@/lib/tasks/types'
import {
    getScenario,
    getStage,
    getRecommendedNext,
    getStageIndex,
    getStageCount,
} from '@/lib/tasks/scenario-config'
import { Clock, ChevronRight, AlertTriangle } from 'lucide-react'

interface ScenarioContextSectionProps {
    task: TaskDTO
    onChangeStage: (newStage: string) => void
}

function formatTimeRemaining(deadline: string): { text: string; color: string } {
    const diff = new Date(deadline).getTime() - Date.now()
    if (diff <= 0) return { text: 'Просрочен', color: 'text-red-600' }

    const hours = Math.floor(diff / (1000 * 60 * 60))
    const days = Math.floor(hours / 24)
    const remainingHours = hours % 24

    if (days > 1) return { text: `${days}д ${remainingHours}ч`, color: 'text-green-600' }
    if (days === 1) return { text: `1д ${remainingHours}ч`, color: 'text-yellow-600' }
    if (hours > 4) return { text: `${hours}ч`, color: 'text-yellow-600' }
    return { text: `${hours}ч ${Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))}мин`, color: 'text-red-600' }
}

export default function ScenarioContextSection({ task, onChangeStage }: ScenarioContextSectionProps) {
    if (!task.scenario) return null

    const scenarioConfig = getScenario(task.scenario)
    if (!scenarioConfig) return null

    const currentStageConfig = task.stage ? getStage(task.scenario, task.stage) : null
    const recommended = task.stage ? getRecommendedNext(task.scenario, task.stage) : null
    const currentIndex = task.stage ? getStageIndex(task.scenario, task.stage) : -1
    const totalStages = getStageCount(task.scenario)

    const slaInfo = task.slaDeadline ? formatTimeRemaining(task.slaDeadline) : null

    return (
        <div className="bg-indigo-50/50 border border-indigo-100 rounded-xl p-3 space-y-3">
            {/* Header: scenario name + SLA */}
            <div className="flex items-center justify-between">
                <span className="text-[12px] font-bold text-indigo-700 uppercase tracking-wider">
                    {scenarioConfig.label}
                </span>
                {slaInfo && (
                    <span className={`flex items-center gap-1 text-[11px] font-bold ${slaInfo.color}`}>
                        {slaInfo.color === 'text-red-600' && <AlertTriangle className="w-3 h-3" />}
                        <Clock className="w-3 h-3" />
                        {slaInfo.text}
                    </span>
                )}
            </div>

            {/* Stage progress bar */}
            <div className="flex items-center gap-1">
                {scenarioConfig.stages.map((stage, idx) => {
                    const isPassed = idx < currentIndex
                    const isCurrent = idx === currentIndex
                    const isFuture = idx > currentIndex

                    return (
                        <div key={stage.id} className="flex items-center flex-1 min-w-0">
                            <button
                                onClick={() => onChangeStage(stage.id)}
                                className={`
                                    flex-1 h-[6px] rounded-full transition-all cursor-pointer
                                    ${isPassed ? 'bg-indigo-400' : ''}
                                    ${isCurrent ? 'bg-indigo-600 shadow-sm' : ''}
                                    ${isFuture ? 'bg-gray-200 hover:bg-gray-300' : ''}
                                `}
                                title={stage.label}
                            />
                            {idx < scenarioConfig.stages.length - 1 && (
                                <ChevronRight className="w-2.5 h-2.5 text-gray-300 shrink-0 mx-0.5" />
                            )}
                        </div>
                    )
                })}
            </div>

            {/* Current stage label */}
            <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold text-gray-800">
                    {currentStageConfig?.label ?? 'Неизвестный этап'}
                    <span className="text-[11px] text-gray-400 ml-1.5">
                        {currentIndex + 1} из {totalStages}
                    </span>
                </span>

                {task.stageEnteredAt && (
                    <span className="text-[11px] text-gray-400">
                        с {new Date(task.stageEnteredAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                    </span>
                )}
            </div>

            {/* Recommended next action */}
            {recommended && task.isActive && (
                <button
                    onClick={() => onChangeStage(recommended.id)}
                    className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-indigo-600 text-white text-[13px] font-semibold hover:bg-indigo-700 transition-colors"
                >
                    <ChevronRight className="w-4 h-4" />
                    {recommended.label}
                </button>
            )}

            {/* Other stages as secondary buttons */}
            {task.isActive && (
                <div className="flex flex-wrap gap-1.5">
                    {scenarioConfig.stages
                        .filter(s => s.id !== task.stage && s.id !== recommended?.id)
                        .map(stage => (
                            <button
                                key={stage.id}
                                onClick={() => onChangeStage(stage.id)}
                                className="px-2.5 py-1 rounded-md text-[11px] font-medium text-gray-500 border border-gray-200 hover:bg-gray-50 hover:text-gray-700 transition-colors"
                            >
                                {stage.label}
                            </button>
                        ))
                    }
                </div>
            )}
        </div>
    )
}
