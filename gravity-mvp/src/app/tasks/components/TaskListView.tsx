'use client'

import { useFilteredTasks } from '@/store/tasks-selectors'
import { Inbox } from 'lucide-react'
import { useTasksStore } from '@/store/tasks-store'
import TaskListRow from './TaskListRow'

export default function TaskListView() {
    const tasks = useFilteredTasks()
    const selectedTaskId = useTasksStore(s => s.selectedTaskId)
    const setSelectedTask = useTasksStore(s => s.setSelectedTask)
    const activeScenario = useTasksStore(s => s.filters.scenario)
    // Если выбрана вкладка конкретного сценария — скрываем тег сценария в строке
    const hideScenarioTag = typeof activeScenario === 'string'

    if (tasks.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-16 h-16 rounded-2xl bg-[#f3f4f6] flex items-center justify-center mb-4">
                    <Inbox className="w-7 h-7 text-[#9ca3af]" />
                </div>
                <p className="text-[15px] font-medium text-[#6b7280]">Нет задач</p>
                <p className="text-[13px] text-[#9ca3af] mt-1">
                    Попробуйте изменить фильтры или создайте новую задачу
                </p>
            </div>
        )
    }

    return (
        <div className="flex flex-col">
            {tasks.map(task => (
                <TaskListRow
                    key={task.id}
                    task={task}
                    isSelected={task.id === selectedTaskId}
                    onSelect={() => setSelectedTask(task.id === selectedTaskId ? null : task.id)}
                    hideScenarioTag={hideScenarioTag}
                />
            ))}
        </div>
    )
}
