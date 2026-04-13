'use client'

import { useState, useEffect } from 'react'
import { useTasksStore } from '@/store/tasks-store'
import { getDictionaries } from '@/lib/dictionaries/dictionary-service'
import { useRouter } from 'next/navigation'
import { getUsers } from '@/lib/users/user-service'
import { useSelectedTask } from '@/store/tasks-selectors'
import { useTaskDetailQuery } from '@/hooks/use-tasks-query'
import { useUpdateTask, useResolveTask } from '@/hooks/use-task-mutations'
import { addTaskAction, correctTaskAction } from '@/app/tasks/actions'
import { Bell } from 'lucide-react'
import ContactResultModal from './details/ContactResultModal'
import ScenarioContextSection from './details/ScenarioContextSection'
import TaskDescription from './details/TaskDescription'
import ChatOriginSection from './details/ChatOriginSection'
import DriverContactCard from './details/DriverContactCard'
import ContactActionButtons from './details/ContactActionButtons'
import NextActionSection from './details/NextActionSection'
import LastContactSection from './details/LastContactSection'
import TaskMetaFields from './details/TaskMetaFields'
import TaskFooterActions from './details/TaskFooterActions'
import TaskDetailHeader from './details/TaskDetailHeader'
import TaskHistorySection from './details/TaskHistorySection'
import CloseReasonModal from './details/CloseReasonModal'
import { getClosedReasons } from '@/lib/tasks/scenario-config'

const STATUS_LABELS: Record<string, string> = {
    todo: 'К выполнению',
    in_progress: 'В работе',
    waiting_reply: 'Ждет ответа',
    overdue: 'Просрочено',
    snoozed: 'Отложена',
    done: 'Выполнено',
    cancelled: 'Отменена',
    archived: 'Архив',
}

const PRIORITY_LABELS: Record<string, { label: string; color: string }> = {
    high: { label: 'Высокий', color: 'text-orange-600 bg-orange-50' },
    medium: { label: 'Обычный', color: 'text-gray-500 bg-gray-50' },
}

const SCENARIO_LABELS: Record<string, string> = {
    connection: 'Подключение',
    contact: 'Контакт',
    churn: 'Отток',
    promo: 'Акция',
}

const EVENT_LABELS: Record<string, string> = {
    created: 'Создана задача',
    status_changed: 'Смена статуса',
    message_sent: 'Сообщение отправлено',
    reply_received: 'Получен ответ',
    priority_changed: 'Смена приоритета',
    assigned: 'Назначена',
    reopened: 'Переоткрыта',
    postponed: 'Перенес срок',
    called: 'Позвонил',
    wrote: 'Написал',
    contact_corrected: 'Обновлено',
    auto_closed: 'Автозакрытие',
}

export default function TaskDetailsPane() {
    const selectedTaskId = useTasksStore((s) => s.selectedTaskId)
    const setSelectedTask = useTasksStore((s) => s.setSelectedTask)
    const task = useSelectedTask()
    const { data: details, isLoading } = useTaskDetailQuery(selectedTaskId)
    const lastContact = details?.events?.find((e: any) => 
        ['called', 'wrote', 'message_sent', 'contacted', 'contact_corrected'].includes(e.eventType)
    )
    const updateTask = useUpdateTask()
    const resolveTask = useResolveTask()
    const router = useRouter()
    const [dicts, setDicts] = useState<any>(null)
    const [users, setUsers] = useState<any[]>([])
    
    // Результат контакта
    const [contactAction, setContactAction] = useState<'called' | 'wrote' | null>(null)
    const [resultId, setResultId] = useState('')
    const [comment, setComment] = useState('')
    const [isSaving, setIsSaving] = useState(false)
    const [editingEventId, setEditingEventId] = useState<string | null>(null)
    const [lastActionTime, setLastActionTime] = useState(0)
    const [showCloseReason, setShowCloseReason] = useState(false)
    const [isClosing, setIsClosing] = useState(false)

    useEffect(() => {
        getDictionaries().then(setDicts)
        getUsers().then(setUsers)
    }, [])

    if (!task) return null

    const scenario = task.scenario || 'contact'
    
    // События зависят от сценария
    const availableEvents = dicts?.events?.filter((e: any) => 
        !e.metadata?.scenario || e.metadata.scenario === scenario
    ) || []

    const prio = PRIORITY_LABELS[task.priority] ?? PRIORITY_LABELS.medium
    const isOverdue = task.dueAt && new Date(task.dueAt) < new Date() && task.isActive

    const getInitials = (firstName?: string, lastName?: string) => {
        const first = firstName?.[0] || '';
        const last = lastName?.[0] || '';
        return (first + last).toUpperCase() || '?';
    };

    const getUserColor = (id: string) => {
        // Simple deterministic hash for color
        let hash = 0;
        for (let i = 0; i < id.length; i++) {
            hash = id.charCodeAt(i) + ((hash << 5) - hash);
        }
        const h = Math.abs(hash % 360);
        return `hsl(${h}, 45%, 55%)`; // Muted but distinct colors
    };

    const handleMarkNewReplyRead = () => {
        if (task.hasNewReply) {
            updateTask.mutate({ id: task.id, patch: { hasNewReply: false } })
        }
    }

    const handleSaveContactResult = async () => {
        if (!contactAction || !resultId) return
        setIsSaving(true)
        try {
            if (editingEventId) {
                await correctTaskAction(task.id, editingEventId, resultId, comment)
            } else {
                await addTaskAction(task.id, contactAction, resultId, comment)
                localStorage.setItem('crm_last_contact_result', resultId)
            }
            setLastActionTime(Date.now())
            updateTask.mutate({ id: task.id, patch: {} }) // Trigger refetch
            setContactAction(null)
            setResultId('')
            setComment('')
            setEditingEventId(null)
        } finally {
            setIsSaving(false)
        }
    }

    const handleEditLastContact = (event: any) => {
        setContactAction(event.eventType === 'contact_corrected' ? 'called' : event.eventType as any)
        setResultId((event.payload as any).newResultId || (event.payload as any).resultId || '')
        setComment((event.payload as any).comment || '')
        setEditingEventId(event.id)
    }

    const handleQuickResult = async (resId: string) => {
        // Double-click protection (2s)
        const now = Date.now()
        if (now - lastActionTime < 2000) return
        
        // Duplicate protection (30s, same result)
        if (lastContact && 
            ['called', 'wrote', 'contact_corrected'].includes(lastContact.eventType) && 
            ((lastContact.payload as any).newResultId || (lastContact.payload as any).resultId) === resId &&
            now - new Date(lastContact.createdAt).getTime() < 30000) {
            alert('Действие уже зафиксировано')
            return
        }

        setLastActionTime(now)
        setIsSaving(true)
        try {
            await addTaskAction(task.id, 'called', resId)
            localStorage.setItem('crm_last_contact_result', resId)
            updateTask.mutate({ id: task.id, patch: {} })
        } finally {
            setIsSaving(false)
        }
    }

    useEffect(() => {
        if (contactAction && !resultId && !editingEventId) {
            const lastRes = localStorage.getItem('crm_last_contact_result')
            if (lastRes) setResultId(lastRes)
        }
    }, [contactAction, resultId, editingEventId])

    const getStatusIndicator = () => {
        if (isOverdue) return { color: 'bg-red-500', label: 'Просрочено' };
        if (task.status === 'done') return { color: 'bg-green-500', label: 'Выполнено' };
        if (task.status === 'cancelled' || task.status === 'archived') return { color: 'bg-gray-400', label: 'Отменена' };
        if (task.status === 'in_progress') return { color: 'bg-blue-500', label: 'В работе' };
        return { color: 'bg-gray-400', label: 'К выполнению' };
    };
    const statusInd = getStatusIndicator();

    return (
        <div className={`w-[380px] shrink-0 border-l border-[#e5e7eb] flex flex-col h-auto overflow-visible animate-in slide-in-from-right-4 duration-200 ${isOverdue ? 'bg-red-50/50 border-l-4 border-l-red-500' : 'bg-white'}`}>
            <TaskDetailHeader
                task={task}
                isOverdue={!!isOverdue}
                statusIndicator={statusInd}
                users={users}
                getInitials={getInitials}
                getUserColor={getUserColor}
                onUpdateAssignee={(val) => updateTask.mutate({ id: task.id, patch: { assigneeId: val } })}
                onUpdateSource={(val) => updateTask.mutate({ id: task.id, patch: { source: val as any } })}
                onUpdatePriority={(val) => updateTask.mutate({ id: task.id, patch: { priority: val as any } })}
                onClose={() => setSelectedTask(null)}
            />

            {/* Content */}
            <div className="flex-1 overflow-visible px-4 py-4 space-y-3">
                {/* New reply banner */}
                {task.hasNewReply && (
                    <button
                        onClick={handleMarkNewReplyRead}
                        className="w-full flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-100 rounded-lg text-[13px] text-blue-700 font-bold hover:bg-blue-100 transition-colors shadow-sm"
                    >
                        <Bell className="w-4 h-4" />
                        Новый ответ водителя
                        <span className="ml-auto text-[11px] text-blue-400">Отметить прочитанным</span>
                    </button>
                )}

                {/* Scenario context — only for scenario tasks */}
                {task.scenario && (
                    <ScenarioContextSection
                        task={task}
                        onChangeStage={(newStage) => updateTask.mutate({ id: task.id, patch: { stage: newStage } })}
                    />
                )}

                {/* 1. Сетка полей: Сценарий | Событие | Статус | Срок */}
                <TaskMetaFields
                    task={task}
                    scenario={scenario}
                    isOverdue={!!isOverdue}
                    scenarios={dicts?.scenarios || []}
                    availableEvents={availableEvents}
                    statusLabels={STATUS_LABELS}
                    onUpdateScenario={() => { /* scenario is set at creation, not changeable via update */ }}
                    onUpdateType={(val) => updateTask.mutate({ id: task.id, patch: { type: val } })}
                    onUpdateStatus={(val) => updateTask.mutate({ id: task.id, patch: { status: val as any } })}
                    onUpdateDueAt={(val) => updateTask.mutate({ id: task.id, patch: { dueAt: val } })}
                />


                {/* Блок: Последний контакт (под сеткой полей) */}
                {lastContact && (
                    <LastContactSection
                        lastContact={lastContact}
                        attempts={task.attempts || 0}
                        users={users}
                        contactResults={dicts?.contact_results || []}
                        historyActions={dicts?.history_actions || []}
                        eventLabels={EVENT_LABELS}
                        onEdit={handleEditLastContact}
                    />
                )}

                {/* Поле: Следующее действие */}
                <NextActionSection
                    nextActionId={task.nextActionId}
                    dueAt={task.dueAt}
                    isOverdue={!!isOverdue}
                    scenario={scenario}
                    nextActions={dicts?.next_actions || []}
                    onNextActionChange={(actionId) => updateTask.mutate({ id: task.id, patch: { scenario: scenario, nextActionId: actionId } as any })}
                    onShiftDue={(shift) => {
                        const current = task.dueAt ? new Date(task.dueAt) : new Date();
                        if (shift === 'hour') current.setHours(current.getHours() + 1);
                        else current.setDate(current.getDate() + 1);
                        updateTask.mutate({ id: task.id, patch: { dueAt: current.toISOString() } });
                    }}
                />

                {/* 2. Блок: ДЕЙСТВИЕ */}
                <ContactActionButtons
                    onAction={(type) => {
                        const now = Date.now();
                        if (now - lastActionTime < 2000) return;
                        setLastActionTime(now);
                        setContactAction(type);
                    }}
                />

                {/* 3. Блок: СВЯЗАТЬСЯ */}
                <DriverContactCard
                    driverName={task.driverName}
                    driverPhone={task.driverPhone}
                    driverId={task.driverId}
                    onCall={() => window.open(`tel:${task.driverPhone}`, '_self')}
                    onWrite={() => router.push(`/messages?msg=new&phone=${task.driverPhone}&driver=${task.driverId}`)}
                    onOpenChat={() => router.push(`/messages?focusedDriver=${task.driverId}`)}
                />
                {task.description && (
                    <TaskDescription description={task.description} />
                )}

                {/* Chat origin */}
                {task.chatId && (
                    <ChatOriginSection
                        chatId={task.chatId}
                        originMessageId={task.originMessageId}
                        originExcerpt={task.originExcerpt}
                    />
                )}

                <TaskHistorySection
                    events={details?.events || []}
                    isLoading={isLoading}
                    lastContactId={lastContact?.id ?? null}
                    users={users}
                    dicts={dicts}
                    statusLabels={STATUS_LABELS}
                    eventLabels={EVENT_LABELS}
                    getInitials={getInitials}
                    getUserColor={getUserColor}
                    onEditEvent={handleEditLastContact}
                />
            </div>

            {/* Footer actions */}
            {task.isActive && (
                <TaskFooterActions
                    scenario={task.scenario}
                    onResolve={(resolution) => resolveTask.mutate({ id: task.id, resolution })}
                    onRequestCloseReason={() => setShowCloseReason(true)}
                />
            )}

            {/* Modal: Результат контакта */}
            {contactAction && (
                <ContactResultModal
                    isEditing={!!editingEventId}
                    resultId={resultId}
                    comment={comment}
                    isSaving={isSaving}
                    contactResults={dicts?.contact_results || []}
                    onResultChange={setResultId}
                    onCommentChange={setComment}
                    onSave={handleSaveContactResult}
                    onClose={() => { setContactAction(null); setEditingEventId(null); }}
                />
            )}

            {/* Modal: Причина закрытия сценарной задачи */}
            {showCloseReason && task.scenario && (
                <CloseReasonModal
                    reasons={getClosedReasons(task.scenario)}
                    isSaving={isClosing}
                    onConfirm={async (reason, comment) => {
                        setIsClosing(true)
                        try {
                            await updateTask.mutateAsync({
                                id: task.id,
                                patch: {
                                    status: 'done',
                                    closedReason: reason,
                                    closedComment: comment || undefined,
                                },
                            })
                            setShowCloseReason(false)
                        } finally {
                            setIsClosing(false)
                        }
                    }}
                    onClose={() => setShowCloseReason(false)}
                />
            )}
        </div>
    )
}

