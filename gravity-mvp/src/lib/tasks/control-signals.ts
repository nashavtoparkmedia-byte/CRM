// ═══════════════════════════════════════════════════════════════════
// Control Signals — problem detection for the "Контроль" list mode.
//
// MVP contract:
//   - 4 signals only: overdue / no_next_action / stale / has_reply
//   - pure functions (no DB, no side effects)
//   - signals drive: highlight (row tint), chip filter, grouping
// ═══════════════════════════════════════════════════════════════════

import type { TaskDTO } from './types'

export type ControlSignal = 'overdue' | 'no_next_action' | 'stale' | 'has_reply'

export const CONTROL_SIGNALS: ControlSignal[] = ['overdue', 'has_reply', 'no_next_action', 'stale']

export const CONTROL_SIGNAL_LABELS: Record<ControlSignal, string> = {
    overdue:        'Просрочено',
    no_next_action: 'Без следующего действия',
    stale:          'Нет движения',
    has_reply:      'Есть ответ без реакции',
}

export const CONTROL_SIGNAL_SHORT_LABELS: Record<ControlSignal, string> = {
    overdue:        'Просрочено',
    no_next_action: 'Без next action',
    stale:          'Нет движения',
    has_reply:      'Новый ответ',
}

/** Row-tint style for highlighting a problem case in Control mode. */
export const CONTROL_SIGNAL_TINT: Record<ControlSignal, string> = {
    overdue:        'bg-[#FEF2F2]',  // light red
    has_reply:      'bg-[#EFF6FF]',  // light blue
    no_next_action: 'bg-[#FEFCE8]',  // light yellow
    stale:          'bg-[#F8FAFC]',  // light gray
}

/** Days of no activity (task.updatedAt) to consider a case "stale". */
export const STALE_DAYS_THRESHOLD = 5

/**
 * Returns all control signals present on a task, in priority order.
 * Priority = order of CONTROL_SIGNALS constant.
 */
export function detectSignals(task: TaskDTO, now: Date = new Date()): ControlSignal[] {
    const signals: ControlSignal[] = []
    const nowMs = now.getTime()

    // 1) overdue — task.status === 'overdue' OR nextActionAt < now OR slaDeadline < now
    const nextAt = task.nextActionAt ? new Date(task.nextActionAt).getTime() : null
    const slaAt  = task.slaDeadline  ? new Date(task.slaDeadline).getTime()  : null
    const isOverdue =
        task.status === 'overdue' ||
        (nextAt !== null && nextAt < nowMs) ||
        (slaAt  !== null && slaAt  < nowMs)
    if (isOverdue) signals.push('overdue')

    // 2) has_reply — inbound message exists without outbound reaction since
    if (task.hasNewReply) signals.push('has_reply')

    // 3) no_next_action — active case, but next action not planned
    if (task.isActive && !task.nextActionAt) signals.push('no_next_action')

    // 4) stale — no updates for N days on an active case
    if (task.isActive && task.updatedAt) {
        const ageDays = (nowMs - new Date(task.updatedAt).getTime()) / (1000 * 60 * 60 * 24)
        if (ageDays >= STALE_DAYS_THRESHOLD) signals.push('stale')
    }

    // Respect priority order
    return CONTROL_SIGNALS.filter(s => signals.includes(s))
}

/** Returns the highest-priority signal for grouping, or null. */
export function primarySignal(task: TaskDTO, now: Date = new Date()): ControlSignal | null {
    const s = detectSignals(task, now)
    return s[0] ?? null
}

/** True if the task has any of the requested signals. */
export function hasAnySignal(
    task: TaskDTO,
    signals: ControlSignal[],
    now: Date = new Date(),
): boolean {
    if (signals.length === 0) return false
    const taskSignals = detectSignals(task, now)
    return signals.some(s => taskSignals.includes(s))
}

export function isHealthy(task: TaskDTO, now: Date = new Date()): boolean {
    return detectSignals(task, now).length === 0
}
