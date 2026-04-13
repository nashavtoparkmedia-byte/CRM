'use client'

import { useState } from 'react'
import { Clock, User } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'

interface LastContactEvent {
    id: string
    eventType: string
    payload: Record<string, unknown>
    actorId: string | null
    createdAt: string
}

interface LastContactSectionProps {
    lastContact: LastContactEvent
    attempts: number
    users: { id: string; firstName?: string; lastName?: string }[]
    contactResults: { id: string; label: string }[]
    historyActions: { id: string; label: string }[]
    eventLabels: Record<string, string>
    onEdit: (event: LastContactEvent) => void
}

export default function LastContactSection({
    lastContact,
    attempts,
    users,
    contactResults,
    historyActions,
    eventLabels,
    onEdit,
}: LastContactSectionProps) {
    const [isCommentExpanded, setIsCommentExpanded] = useState(false)

    const resId = (lastContact.payload as any)?.newResultId || (lastContact.payload as any)?.resultId
    const bgClass = resId === 'no_answer' ? 'bg-yellow-50 border-yellow-100' :
                   resId === 'docs_waiting' ? 'bg-blue-50 border-blue-100' :
                   resId === 'problem_solved' ? 'bg-green-50 border-green-100' :
                   resId === 'rejected' ? 'bg-red-50 border-red-100' :
                   'bg-indigo-50/50 border-indigo-100/50'
    const labelColor = resId === 'no_answer' ? 'text-yellow-600' :
                      resId === 'docs_waiting' ? 'text-blue-600' :
                      resId === 'problem_solved' ? 'text-green-600' :
                      resId === 'rejected' ? 'text-red-600' :
                      'text-indigo-400'

    const actionLabel = eventLabels[lastContact.eventType] || historyActions.find((a) => a.id === lastContact.eventType)?.label
    const resultLabel = resId ? (contactResults.find((r) => r.id === resId)?.label || resId) : null
    const commentText = (lastContact.payload as any)?.comment as string | undefined
    const isLongComment = (commentText?.length ?? 0) > 80

    const actorUser = users.find((u) => u.id === lastContact.actorId)
    const actorName = actorUser ? `${actorUser.firstName || ''} ${actorUser.lastName || ''}`.trim() : 'Менеджер'

    return (
        <div className={`p-3 border rounded-xl animate-in fade-in slide-in-from-top-1 duration-300 ${bgClass}`}>
            <div className={`flex items-center gap-1.5 text-section-label mb-2 ${labelColor}`}>
                <Clock className="w-3 h-3" />
                Последний контакт
            </div>
            <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <p className="text-primary-value leading-tight">
                        {resultLabel || (!actionLabel ? lastContact.eventType : null)}
                    </p>

                    {lastContact.eventType === 'contact_corrected' && actionLabel && (
                        <p className="text-meta !text-[#94A3B8] mt-1 leading-none">
                            {actionLabel}
                        </p>
                    )}

                    {commentText && (
                        <div className="mt-1.5 flex flex-col items-start">
                            <p className={`text-secondary-value italic leading-snug ${!isCommentExpanded ? 'line-clamp-2' : ''}`}>
                                «{commentText}»
                            </p>
                            {isLongComment && !isCommentExpanded && (
                                <button
                                    onClick={() => setIsCommentExpanded(true)}
                                    className="text-meta !text-[#4F46E5] hover:underline mt-0.5"
                                >
                                    Показать полностью
                                </button>
                            )}
                            {isLongComment && isCommentExpanded && (
                                <button
                                    onClick={() => setIsCommentExpanded(false)}
                                    className="text-meta !text-[#4F46E5] hover:underline mt-0.5"
                                >
                                    Скрыть
                                </button>
                            )}
                        </div>
                    )}
                </div>
                <div className="text-right shrink-0 flex flex-col items-end">
                    <span className="text-meta bg-white/80 px-1.5 py-0.5 rounded border border-gray-100 shadow-sm mt-0.5">
                        {new Date(lastContact.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, {new Date(lastContact.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                </div>
            </div>

            {/* Touch Counter */}
            <div className="mt-3 pt-2 border-t border-black/5 flex items-center justify-between">
                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <div style={{ fontSize: '11px', padding: '4px 8px', borderRadius: '999px', background: '#F1F5F9', color: '#475569' }} className="cursor-help flex items-center gap-1 group/touches transition-colors hover:bg-slate-200">
                                <span className="group-hover/touches:text-[#4F46E5] transition-colors font-semibold">{attempts}</span> касаний
                            </div>
                        </TooltipTrigger>
                        <TooltipContent className="bg-slate-900 text-white p-3 max-w-[220px] border-none shadow-xl">
                            <p className="font-bold text-[13px] mb-1">Всего касаний</p>
                            <p className="text-[12px] opacity-80 leading-snug">
                                Количество попыток связаться с водителем.<br/>
                                <span className="mt-2 block pt-1 border-t border-white/10">
                                    Считаются: <b>Позвонил, Написал</b>.<br/>
                                    Не считаются: Перенос срока, Смена статуса.
                                </span>
                            </p>
                        </TooltipContent>
                    </Tooltip>
                </TooltipProvider>

                <div className="flex items-center gap-3">
                    <span className="text-meta !text-[#94A3B8] flex items-center gap-1">
                        <User className="w-2.5 h-2.5" />
                        {actorName}
                    </span>
                    <button
                        onClick={() => onEdit(lastContact)}
                        className="text-meta !text-[#4F46E5] hover:underline cursor-pointer"
                    >
                        Изменить
                    </button>
                </div>
            </div>
        </div>
    )
}
