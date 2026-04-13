'use client'

import React, { useState } from 'react'
import { FileText } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { TaskEventDTO } from '@/lib/tasks/types'
import { getClosedReasons } from '@/lib/tasks/scenario-config'
import { CONTACT_EVENT_TYPES, isLateResponse, formatResponseTime } from '@/lib/tasks/response-config'

interface TaskHistorySectionProps {
    events: TaskEventDTO[]
    isLoading: boolean
    lastContactId: string | null
    users: any[]
    dicts: any
    statusLabels: Record<string, string>
    eventLabels: Record<string, string>
    getInitials: (firstName?: string, lastName?: string) => string
    getUserColor: (id: string) => string
    onEditEvent: (event: any) => void
}

export default function TaskHistorySection({
    events,
    isLoading,
    lastContactId,
    users,
    dicts,
    statusLabels: STATUS_LABELS,
    eventLabels: EVENT_LABELS,
    getInitials,
    getUserColor,
    onEditEvent,
}: TaskHistorySectionProps) {
    const [historyMode, setHistoryMode] = useState<'actions' | 'all'>('actions')
    const [isHistoryExpanded, setIsHistoryExpanded] = useState(false)
    const [expandedPostponed, setExpandedPostponed] = useState<Set<string>>(new Set())

    return (
        <div>
            <div className="flex items-center justify-between mb-3">
                <h4 className="text-section-label flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5" />
                    История
                </h4>
                <div className="flex bg-[#F1F5F9] rounded-md p-0.5" style={{ fontSize: '11px' }}>
                    <button
                        onClick={() => setHistoryMode('actions')}
                        className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                            historyMode === 'actions'
                                ? 'bg-white text-[#111827] shadow-sm font-medium'
                                : 'text-[#94A3B8] hover:text-[#64748B]'
                        }`}
                    >
                        Действия
                    </button>
                    <button
                        onClick={() => setHistoryMode('all')}
                        className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                            historyMode === 'all'
                                ? 'bg-white text-[#111827] shadow-sm font-medium'
                                : 'text-[#94A3B8] hover:text-[#64748B]'
                        }`}
                    >
                        Все
                    </button>
                </div>
            </div>
            {isLoading ? (
                <div className="space-y-2">
                    {[1, 2, 3].map((i) => (
                        <div key={i} className="h-8 bg-[#f3f4f6] rounded-lg animate-pulse" />
                    ))}
                </div>
            ) : events && events.length > 0 ? (
                <div className={`space-y-0 ${isHistoryExpanded && (events?.length || 0) > 10 ? 'max-h-[300px] overflow-y-auto pr-2 custom-scrollbar' : ''}`}>
                    {(() => {
                        // Calculate first response time
                        const createdEvent = events.find((e: any) => e.eventType === 'created');
                        const allContactEvents = events.filter((e: any) => CONTACT_EVENT_TYPES.includes(e.eventType));
                        // First contact = oldest contact event
                        const firstContact = allContactEvents.length > 0
                            ? allContactEvents.reduce((oldest: any, e: any) =>
                                new Date(e.createdAt) < new Date(oldest.createdAt) ? e : oldest
                            )
                            : null;
                        const firstContactId = firstContact?.id || null;
                        let responseTimeMinutes: number | null = null;
                        let responseLate = false;
                        if (createdEvent && firstContact) {
                            responseTimeMinutes = (new Date(firstContact.createdAt).getTime() - new Date(createdEvent.createdAt).getTime()) / 60000;
                            responseLate = isLateResponse(responseTimeMinutes);
                        }

                        // Technical event types to hide in 'actions' mode
                        const technicalTypes = ['postponed', 'status_changed', 'priority_changed'];
                        const rawEvents = historyMode === 'actions'
                            ? events.filter((e: any) => !technicalTypes.includes(e.eventType))
                            : events;

                        // Filter out no-op postponed events (from === to)
                        const isNoOpPostponed = (e: any) => {
                            if (e.eventType !== 'postponed' || !e.payload) return false;
                            const f = e.payload.from, t = e.payload.to;
                            if (!f || !t) return false;
                            // Compare truncated to minute
                            return f.slice(0, 16) === t.slice(0, 16);
                        };
                        const baseEvents = rawEvents.filter((e: any) => !isNoOpPostponed(e));

                        // Sort newest first
                        const sortedEvents = [...(isHistoryExpanded ? baseEvents : baseEvents.slice(0, 3))].sort(
                            (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
                        );

                        // Collapse consecutive postponed: keep first, store hidden ones
                        const processedEvents: { event: any; collapsedCount?: number; collapsedEvents?: any[]; groupKey?: string }[] = [];
                        for (let i = 0; i < sortedEvents.length; i++) {
                            const ev = sortedEvents[i];
                            if (ev.eventType === 'postponed') {
                                const hidden: any[] = [];
                                while (i + 1 < sortedEvents.length && sortedEvents[i + 1].eventType === 'postponed' && sortedEvents[i + 1].actorId === ev.actorId) {
                                    i++;
                                    hidden.push(sortedEvents[i]);
                                }
                                processedEvents.push({
                                    event: ev,
                                    collapsedCount: hidden.length > 0 ? hidden.length : undefined,
                                    collapsedEvents: hidden.length > 0 ? hidden : undefined,
                                    groupKey: ev.id,
                                });
                            } else {
                                processedEvents.push({ event: ev });
                            }
                        }

                        // Day separator helper
                        const now = new Date();
                        const todayStr = now.toLocaleDateString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit' });
                        const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
                        const yesterdayStr = yesterday.toLocaleDateString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit' });
                        const getDayLabel = (date: Date) => {
                            const ds = date.toLocaleDateString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit' });
                            if (ds === todayStr) return 'Сегодня';
                            if (ds === yesterdayStr) return 'Вчера';
                            return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
                        };

                        // Actor type display config
                        const ACTOR_DISPLAY: Record<string, { label: string; initials: string; color: string }> = {
                            system: { label: 'Система', initials: 'С', color: '#94A3B8' },
                            auto:   { label: 'Авто', initials: 'A', color: '#6366F1' },
                            ai:     { label: 'ИИ', initials: 'И', color: '#8B5CF6' },
                            driver: { label: 'Водитель', initials: 'В', color: '#059669' },
                        }

                        // Group by consecutive actorId + actorType
                        const actorGroups: { actorId: string; actorType: string; actorUser: any; actorName: string; actorInitials: string; actorColor: string; items: typeof processedEvents }[] = [];
                        processedEvents.forEach((item) => {
                            const lastGroup = actorGroups[actorGroups.length - 1];
                            const evActorType = item.event.actorType || 'system';
                            if (lastGroup && lastGroup.actorId === item.event.actorId && lastGroup.actorType === evActorType) {
                                lastGroup.items.push(item);
                            } else {
                                const actorUser = evActorType === 'user' ? users.find((u: any) => u.id === item.event.actorId) : null;
                                const display = ACTOR_DISPLAY[evActorType] || ACTOR_DISPLAY.system;
                                const actorName = actorUser ? `${actorUser.firstName} ${actorUser.lastName || ''}`.trim() : display.label;
                                const actorInitials = actorUser ? getInitials(actorUser.firstName, actorUser.lastName) : display.initials;
                                const actorColor = actorUser ? getUserColor(actorUser.id) : display.color;
                                actorGroups.push({ actorId: item.event.actorId, actorType: evActorType, actorUser, actorName, actorInitials, actorColor, items: [item] });
                            }
                        });

                        // Track last rendered day for separators
                        let lastDay = '';

                        return actorGroups.map((group, gi) => {
                            // Check if we need a day separator before this group
                            const groupDay = getDayLabel(new Date(group.items[0].event.createdAt));
                            let showDaySeparator = false;
                            if (groupDay !== lastDay) {
                                showDaySeparator = true;
                                lastDay = groupDay;
                            }

                            return (
                                <div key={`g-${gi}`}>
                                    {showDaySeparator && (
                                        <div className={`flex items-center gap-2 ${gi > 0 ? 'mt-3 mb-2' : 'mb-2'}`}>
                                            <span style={{ fontSize: '11px', fontWeight: 500, color: '#94A3B8' }} className="uppercase tracking-wide shrink-0">{groupDay}</span>
                                            <div className="flex-1 h-px bg-[#F0F0F0]" />
                                        </div>
                                    )}
                                    <div className={`${!showDaySeparator && gi > 0 ? 'mt-2' : ''}`}>
                                        {/* Actor header — initials + type badge */}
                                        <div className="flex items-center gap-1.5 mb-1">
                                            <TooltipProvider>
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <div
                                                            className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[9px] font-bold cursor-help shrink-0"
                                                            style={{ backgroundColor: group.actorColor }}
                                                        >
                                                            {group.actorInitials}
                                                        </div>
                                                    </TooltipTrigger>
                                                    <TooltipContent className="bg-slate-800 border-none text-white text-[11px] font-bold px-2.5 py-1">
                                                        {group.actorName}
                                                    </TooltipContent>
                                                </Tooltip>
                                            </TooltipProvider>
                                            {group.actorType !== 'user' && (
                                                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full" style={{
                                                    color: group.actorColor,
                                                    backgroundColor: `${group.actorColor}15`,
                                                }}>
                                                    {group.actorName}
                                                </span>
                                            )}
                                        </div>
                                        {/* Events */}
                                        <div className="ml-[26px] space-y-1.5">
                                            {group.items.map((item) => {
                                                const event = item.event;
                                                const hasResult = event.payload && (event.payload as any).resultId;
                                                const resultLabel = hasResult ? dicts?.contact_results?.find((r: any) => r.id === (event.payload as any).resultId)?.label : null;
                                                const isContactAction = ['called', 'wrote'].includes(event.eventType);
                                                const isStatusChange = event.eventType === 'status_changed';
                                                const isCorrected = event.eventType === 'contact_corrected';
                                                const isSlaEscalated = event.eventType === 'sla_escalated';

                                                // Build event label
                                                let eventTitle: React.ReactNode;
                                                const technicalEventTypes = ['status_changed', 'postponed', 'priority_changed'];
                                                const isCreated = event.eventType === 'created';

                                                if (isStatusChange) {
                                                    const payload = event.payload as any;
                                                    const isCloseEvent = payload.to === 'done' || payload.to === 'cancelled';
                                                    const closedReason = payload.closedReason;
                                                    const closedComment = payload.closedComment;
                                                    // Resolve closedReason label from scenario config (check all scenarios)
                                                    let reasonLabel = closedReason;
                                                    if (closedReason && payload.scenario) {
                                                        const reasons = getClosedReasons(payload.scenario);
                                                        reasonLabel = reasons.find(r => r.value === closedReason)?.label || closedReason;
                                                    } else if (closedReason) {
                                                        // No scenario in payload — search all scenarios for label
                                                        for (const sid of ['churn', 'onboarding', 'care', 'promo_control']) {
                                                            const match = getClosedReasons(sid).find(r => r.value === closedReason);
                                                            if (match) { reasonLabel = match.label; break; }
                                                        }
                                                    }

                                                    eventTitle = (
                                                        <div className="flex flex-col">
                                                            <span style={{ fontWeight: 400, color: '#64748B' }} className="text-[13px]">
                                                                {dicts?.history_actions?.find((a: any) => a.id === 'status_changed')?.label || 'Смена статуса'}
                                                            </span>
                                                            <span style={{ fontWeight: 400, color: '#94A3B8' }} className="text-[12px] mt-0.5">
                                                                {STATUS_LABELS[payload.from] || payload.from} → {STATUS_LABELS[payload.to] || payload.to}
                                                            </span>
                                                            {isCloseEvent && closedReason && (
                                                                <span style={{ fontWeight: 400, color: '#64748B' }} className="text-[12px] mt-1">
                                                                    Причина: <span style={{ fontWeight: 500, color: '#374151' }}>{reasonLabel}</span>
                                                                </span>
                                                            )}
                                                            {isCloseEvent && closedComment && (
                                                                <p className="text-[11px] text-[#64748B] italic mt-0.5 bg-gray-50 px-1.5 py-0.5 rounded border-l-2 border-gray-200">
                                                                    «{closedComment}»
                                                                </p>
                                                            )}
                                                        </div>
                                                    );
                                                } else if (isCorrected) {
                                                    // User action: bold result transition
                                                    eventTitle = (
                                                        <span style={{ fontWeight: 500 }} className="text-[#111827]">
                                                            {dicts?.contact_results?.find((r: any) => r.id === (event.payload as any).oldResultId)?.label || (event.payload as any).oldResultId}
                                                            {' → '}
                                                            {dicts?.contact_results?.find((r: any) => r.id === (event.payload as any).newResultId)?.label || (event.payload as any).newResultId}
                                                        </span>
                                                    );
                                                } else if (isContactAction && resultLabel) {
                                                    // User action: bold result
                                                    eventTitle = <span style={{ fontWeight: 500 }} className="text-[#111827]">{resultLabel}</span>;
                                                } else if (isCreated) {
                                                    // Created: lightest
                                                    eventTitle = <span style={{ fontWeight: 400, color: '#94A3B8' }} className="text-[13px]">{EVENT_LABELS.created}</span>;
                                                } else if (isSlaEscalated) {
                                                    const overdueBy = (event.payload as any)?.overdueBy;
                                                    eventTitle = (
                                                        <span style={{ fontWeight: 600 }} className="text-red-600 text-[13px]">
                                                            {EVENT_LABELS.sla_escalated || 'SLA просрочен'}
                                                            {overdueBy && <span className="text-red-400 font-normal ml-1">({overdueBy})</span>}
                                                        </span>
                                                    );
                                                } else if (technicalEventTypes.includes(event.eventType)) {
                                                    // Technical: muted
                                                    const label = dicts?.history_actions?.find((a: any) => a.id === event.eventType)?.label || EVENT_LABELS[event.eventType] || event.eventType;
                                                    eventTitle = <span style={{ fontWeight: 400, color: '#64748B' }} className="text-[13px]">{label}</span>;
                                                } else {
                                                    // User actions: bold
                                                    const label = dicts?.history_actions?.find((a: any) => a.id === event.eventType)?.label || EVENT_LABELS[event.eventType] || event.eventType;
                                                    eventTitle = <span style={{ fontWeight: 500 }} className="text-[#111827]">{label}</span>;
                                                }

                                                return (
                                                    <div key={event.id}>
                                                        <div className="flex items-start gap-2">
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-start gap-1.5">
                                                                    <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${isSlaEscalated ? 'bg-red-500' : 'bg-[#d1d5db]'}`} />
                                                                    <div className="flex-1 min-w-0">
                                                                        {eventTitle}
                                                                        {/* Response time on first contact */}
                                                                        {event.id === firstContactId && responseTimeMinutes !== null && (
                                                                            <span className={`text-[11px] font-medium ml-1.5 px-1.5 py-0.5 rounded inline-block mt-0.5 ${
                                                                                responseLate
                                                                                    ? 'bg-orange-100 text-orange-600'
                                                                                    : 'bg-green-50 text-green-600'
                                                                            }`}>
                                                                                {responseLate ? 'Медленный ответ: ' : 'Ответ через: '}{formatResponseTime(responseTimeMinutes)}
                                                                            </span>
                                                                        )}
                                                                        {/* Postponed detail line */}
                                                                        {event.eventType === 'postponed' && event.payload && (event.payload as any).from && (
                                                                            <span style={{ fontWeight: 400, color: '#94A3B8' }} className="text-[12px] block mt-0.5">
                                                                                {`${new Date((event.payload as any).from).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${new Date((event.payload as any).from).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} → ${new Date((event.payload as any).to).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${new Date((event.payload as any).to).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`}
                                                                            </span>
                                                                        )}
                                                                        {/* Collapsed postponed toggle */}
                                                                        {item.collapsedCount && item.groupKey && (
                                                                            <>
                                                                                {!expandedPostponed.has(item.groupKey) && (
                                                                                    <button
                                                                                        onClick={() => {
                                                                                            setExpandedPostponed(prev => {
                                                                                                const next = new Set(prev);
                                                                                                next.add(item.groupKey!);
                                                                                                return next;
                                                                                            });
                                                                                        }}
                                                                                        style={{ fontSize: '11px', fontWeight: 400, color: '#94A3B8' }}
                                                                                        className="block mt-0.5 cursor-pointer hover:text-[#64748B] hover:underline transition-colors"
                                                                                    >
                                                                                        {`ещё ${item.collapsedCount} ${item.collapsedCount === 1 ? 'изменение' : item.collapsedCount < 5 ? 'изменения' : 'изменений'} срока`}
                                                                                    </button>
                                                                                )}
                                                                                {expandedPostponed.has(item.groupKey) && item.collapsedEvents && (
                                                                                    <div className="mt-1.5 ml-0">
                                                                                        <span style={{ fontSize: '12px', fontWeight: 500, color: '#64748B' }} className="block mb-1.5">История изменений срока:</span>
                                                                                        <div className="space-y-0.5">
                                                                                            {/* Include the main event's time range first */}
                                                                                            {event.payload && (event.payload as any).from && (
                                                                                                <span style={{ fontWeight: 400, color: '#94A3B8' }} className="text-[12px] block">
                                                                                                    {`${new Date((event.payload as any).from).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} → ${new Date((event.payload as any).to).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`}
                                                                                                </span>
                                                                                            )}
                                                                                            {item.collapsedEvents.map((ce: any) => (
                                                                                                <span key={ce.id} style={{ fontWeight: 400, color: '#94A3B8' }} className="text-[12px] block">
                                                                                                    {ce.payload && (ce.payload as any).from
                                                                                                        ? `${new Date((ce.payload as any).from).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} → ${new Date((ce.payload as any).to).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
                                                                                                        : ''}
                                                                                                </span>
                                                                                            ))}
                                                                                        </div>
                                                                                        <button
                                                                                            onClick={() => {
                                                                                                setExpandedPostponed(prev => {
                                                                                                    const next = new Set(prev);
                                                                                                    next.delete(item.groupKey!);
                                                                                                    return next;
                                                                                                });
                                                                                            }}
                                                                                            style={{ fontSize: '11px', fontWeight: 400, color: '#94A3B8' }}
                                                                                            className="block mt-1.5 cursor-pointer hover:text-[#64748B] hover:underline transition-colors"
                                                                                        >
                                                                                            Свернуть изменения срока
                                                                                        </button>
                                                                                    </div>
                                                                                )}
                                                                            </>
                                                                        )}
                                                                        {(event.payload as any).comment && (
                                                                            <p className="text-[11px] text-[#4F46E5]/70 italic mt-0.5 bg-blue-50/30 px-1.5 py-0.5 rounded border-l-2 border-blue-200">
                                                                                «{(event.payload as any).comment}»
                                                                            </p>
                                                                        )}
                                                                        {event.id === lastContactId && (
                                                                            <button
                                                                                onClick={() => onEditEvent(event)}
                                                                                style={{ fontSize: '12px', color: '#94A3B8' }}
                                                                                className="hover:underline cursor-pointer mt-0.5 block"
                                                                            >
                                                                                Изменить
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <span style={{ fontWeight: 400, color: '#94A3B8' }} className="text-[11px] shrink-0 mt-0.5 w-[90px] text-right">
                                                                {new Date(event.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + new Date(event.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                                                            </span>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>
                            );
                        });
                    })()}
                    {(() => {
                        const technicalTypes = ['postponed', 'status_changed', 'priority_changed'];
                        const filteredCount = historyMode === 'actions'
                            ? events.filter((e: any) => !technicalTypes.includes(e.eventType)).length
                            : events.length;
                        return filteredCount > 3 ? (
                            <button
                                onClick={() => setIsHistoryExpanded(!isHistoryExpanded)}
                                style={{ fontSize: '12px', fontWeight: 400, color: '#94A3B8' }}
                                className="hover:text-[#64748B] hover:underline mt-1.5 cursor-pointer block transition-colors"
                            >
                                {isHistoryExpanded ? 'Свернуть' : 'Показать ещё'}
                            </button>
                        ) : null;
                    })()}
                </div>
            ) : (
                <p className="text-meta !text-[#94A3B8]">Нет событий</p>
            )}
        </div>
    )
}
