'use client'

// ═══════════════════════════════════════════════════════════════════
// TaskCaseInlineActions — 4 hover-only quick actions per row:
//   • Позвонил      — creates 'called' TaskEvent
//   • Написал       — creates 'wrote' TaskEvent
//   • Перенести     — dropdown: today / tomorrow / +3d / pick date
//   • Эскалировать  — dropdown: to_lead / to_senior / mark_critical
//
// Uses optimistic updates via the tasks-store, then invalidates the
// tasks query so the row reflects real server state within ~300ms.
// ═══════════════════════════════════════════════════════════════════

import { useState, useRef, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Phone, MessageSquare, Clock, Flame, Loader2, ChevronDown } from 'lucide-react'
import type { TaskDTO } from '@/lib/tasks/types'
import { useTasksStore } from '@/store/tasks-store'
import { pushToast } from '@/lib/tasks/toast-store'
import { recordUsage } from '@/lib/tasks/usage'
import {
    inlineLogCall,
    inlineLogMessage,
    inlineReschedule,
    inlineEscalate,
    type InlineEscalationKind,
} from '../case-actions'

interface Props {
    task: TaskDTO
}

type BusyKey = 'call' | 'message' | 'reschedule' | 'escalate' | null

export default function TaskCaseInlineActions({ task }: Props) {
    const qc = useQueryClient()
    const upsertTask = useTasksStore(s => s.upsertTask)
    const [busy, setBusy] = useState<BusyKey>(null)

    const runOptimistic = async (
        key: BusyKey,
        optimistic: Partial<TaskDTO>,
        serverCall: () => Promise<void>,
        successText?: string,
    ) => {
        if (busy) return
        setBusy(key)
        void recordUsage('inline_action', { kind: key, taskId: task.id })
        const prev = task
        upsertTask({ ...prev, ...optimistic })
        try {
            await serverCall()
            await qc.invalidateQueries({ queryKey: ['tasks'] })
            if (successText) pushToast(successText, 'success')
        } catch (e) {
            upsertTask(prev) // revert
            pushToast((e as Error).message || 'Не удалось выполнить', 'error')
        } finally {
            setBusy(null)
        }
    }

    const onCall = () => runOptimistic(
        'call',
        {
            lastContactAt: new Date().toISOString(),
            lastContactType: 'called',
            touchCount: task.touchCount + 1,
        },
        () => inlineLogCall(task.id),
        'Звонок отмечен',
    )

    const onMessage = () => runOptimistic(
        'message',
        {
            lastContactAt: new Date().toISOString(),
            lastContactType: 'wrote',
            touchCount: task.touchCount + 1,
        },
        () => inlineLogMessage(task.id),
        'Сообщение отмечено',
    )

    const onReschedule = (newIso: string) => runOptimistic(
        'reschedule',
        { nextActionAt: newIso, dueAt: newIso, status: 'in_progress' },
        () => inlineReschedule(task.id, newIso),
        'Дедлайн перенесён',
    )

    const onEscalate = (kind: InlineEscalationKind) => {
        const patch: Partial<TaskDTO> = {
            isEscalated: true,
            escalated: true,
        }
        if (kind === 'mark_critical') patch.priority = 'critical'
        runOptimistic(
            'escalate',
            patch,
            () => inlineEscalate(task.id, kind),
            kind === 'mark_critical' ? 'Помечено как критичное' : 'Эскалировано',
        )
    }

    return (
        <div
            className="flex items-center gap-0.5"
            onClick={(e) => e.stopPropagation()}
        >
            <IconButton busy={busy === 'call'} title="Позвонил" onClick={onCall}>
                <Phone size={13} />
            </IconButton>
            <IconButton busy={busy === 'message'} title="Написал" onClick={onMessage}>
                <MessageSquare size={13} />
            </IconButton>
            <RescheduleMenu busy={busy === 'reschedule'} onPick={onReschedule} />
            <EscalateMenu busy={busy === 'escalate'} onPick={onEscalate} />
        </div>
    )
}

// ─── Building blocks ─────────────────────────────────────────────────

function IconButton({
    busy, title, onClick, children,
}: {
    busy?: boolean
    title: string
    onClick: () => void
    children: React.ReactNode
}) {
    return (
        <button
            onClick={onClick}
            disabled={!!busy}
            title={title}
            className="w-7 h-7 flex items-center justify-center rounded-md text-[#64748B] hover:bg-white hover:text-[#1E40AF] hover:shadow-sm transition-colors disabled:opacity-50"
        >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : children}
        </button>
    )
}

function useClickOutside<T extends HTMLElement>(onClose: () => void) {
    const ref = useRef<T>(null)
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (!ref.current) return
            if (!ref.current.contains(e.target as Node)) onClose()
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [onClose])
    return ref
}

// ─── Reschedule menu ─────────────────────────────────────────────────

function RescheduleMenu({ busy, onPick }: { busy: boolean; onPick: (iso: string) => void }) {
    const [open, setOpen] = useState(false)
    const ref = useClickOutside<HTMLDivElement>(() => setOpen(false))

    const pick = (dateFn: () => Date) => {
        const d = dateFn()
        d.setHours(18, 0, 0, 0) // 18:00 local — sensible default for a deadline
        onPick(d.toISOString())
        setOpen(false)
    }

    const pickCustom = (iso: string) => {
        if (!iso) return
        const d = new Date(iso)
        onPick(d.toISOString())
        setOpen(false)
    }

    return (
        <div ref={ref} className="relative">
            <IconButton busy={busy} title="Перенести дедлайн" onClick={() => setOpen(o => !o)}>
                <Clock size={13} />
            </IconButton>
            {open && (
                <div className="absolute right-0 top-full mt-1 z-40 min-w-[180px] bg-white rounded-lg shadow-md border border-[#E4ECFC] py-1 text-[13px]">
                    <MenuItem onClick={() => pick(() => new Date())}>Сегодня</MenuItem>
                    <MenuItem onClick={() => pick(() => { const d = new Date(); d.setDate(d.getDate() + 1); return d })}>
                        Завтра
                    </MenuItem>
                    <MenuItem onClick={() => pick(() => { const d = new Date(); d.setDate(d.getDate() + 3); return d })}>
                        +3 дня
                    </MenuItem>
                    <div className="border-t border-[#EEF2FF] my-1" />
                    <label className="flex items-center gap-2 px-3 py-1.5 text-[#64748B] hover:bg-[#F8FAFC] cursor-pointer">
                        <span>Выбрать дату</span>
                        <input
                            type="date"
                            onChange={(e) => pickCustom(e.target.value)}
                            className="ml-auto text-[12px] bg-transparent outline-none"
                        />
                    </label>
                </div>
            )}
        </div>
    )
}

// ─── Escalate menu ───────────────────────────────────────────────────

function EscalateMenu({
    busy, onPick,
}: {
    busy: boolean
    onPick: (kind: InlineEscalationKind) => void
}) {
    const [open, setOpen] = useState(false)
    const ref = useClickOutside<HTMLDivElement>(() => setOpen(false))

    const pick = (kind: InlineEscalationKind) => {
        onPick(kind)
        setOpen(false)
    }

    return (
        <div ref={ref} className="relative">
            <IconButton busy={busy} title="Эскалировать" onClick={() => setOpen(o => !o)}>
                <Flame size={13} />
            </IconButton>
            {open && (
                <div className="absolute right-0 top-full mt-1 z-40 min-w-[220px] bg-white rounded-lg shadow-md border border-[#E4ECFC] py-1 text-[13px]">
                    <MenuItem onClick={() => pick('to_lead')}>Передать руководителю</MenuItem>
                    <MenuItem onClick={() => pick('to_senior')}>Передать старшему менеджеру</MenuItem>
                    <div className="border-t border-[#EEF2FF] my-1" />
                    <MenuItem onClick={() => pick('mark_critical')} danger>
                        Отметить как критичный
                    </MenuItem>
                </div>
            )}
        </div>
    )
}

function MenuItem({
    children, onClick, danger,
}: {
    children: React.ReactNode
    onClick: () => void
    danger?: boolean
}) {
    return (
        <button
            onClick={onClick}
            className={`w-full text-left px-3 py-1.5 hover:bg-[#F8FAFC] transition-colors ${
                danger ? 'text-[#B91C1C]' : 'text-[#0F172A]'
            }`}
        >
            {children}
        </button>
    )
}

function ChevronDownHint() {
    return <ChevronDown size={10} className="opacity-50" />
}
void ChevronDownHint
