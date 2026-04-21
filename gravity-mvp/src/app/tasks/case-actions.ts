'use server'

// ═══════════════════════════════════════════════════════════════════
// Case Inline Actions — lightweight server actions for row-level UX.
// All four return void; the client is responsible for optimistic
// update + queryClient.invalidateQueries(['tasks']).
// ═══════════════════════════════════════════════════════════════════

import { prisma } from '@/lib/prisma'
import { logTaskEvent } from '@/lib/tasks/task-event-service'
import { addTaskAction, updateTask } from './actions'
import type { Prisma } from '@prisma/client'

// ─── Позвонил ─────────────────────────────────────────────────────

export async function inlineLogCall(taskId: string): Promise<void> {
    // Reuses existing logic: writes TaskEvent type='called' + bumps attempts.
    await addTaskAction(taskId, 'called')
}

// ─── Написал ──────────────────────────────────────────────────────

export async function inlineLogMessage(taskId: string): Promise<void> {
    await addTaskAction(taskId, 'wrote')
}

// ─── Перенести дедлайн ────────────────────────────────────────────

export async function inlineReschedule(taskId: string, newIso: string): Promise<void> {
    // updateTask auto-logs 'postponed' when dueAt changes; we move nextActionAt
    // which is the primary "deadline" on churn list rows.
    await updateTask(taskId, { nextActionAt: newIso, dueAt: newIso })
}

// ─── Эскалировать ─────────────────────────────────────────────────

export type InlineEscalationKind = 'to_lead' | 'to_senior' | 'mark_critical'

const ESCALATION_LABELS: Record<InlineEscalationKind, string> = {
    to_lead: 'Передано руководителю',
    to_senior: 'Передано старшему менеджеру',
    mark_critical: 'Помечено как критичное',
}

export async function inlineEscalate(
    taskId: string,
    kind: InlineEscalationKind,
): Promise<void> {
    const task = await prisma.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { id: true, metadata: true, priority: true },
    })
    const meta = (task.metadata as Record<string, unknown>) || {}

    const data: Prisma.TaskUpdateInput = {
        metadata: {
            ...meta,
            escalated: true,
            escalationKind: kind,
            escalatedAt: new Date().toISOString(),
        },
    }
    if (kind === 'mark_critical' && task.priority !== 'critical') {
        data.priority = 'critical'
    }

    await prisma.task.update({ where: { id: taskId }, data })
    await logTaskEvent(
        taskId,
        'escalated',
        { kind, label: ESCALATION_LABELS[kind] },
        { type: 'user' },
    )
}
