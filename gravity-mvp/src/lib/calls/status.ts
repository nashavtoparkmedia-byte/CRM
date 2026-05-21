/**
 * Centralized telephony call status taxonomy.
 *
 * Maps FreeSWITCH hangup causes → Call.status (DB enum) → user-facing
 * Russian label + UI color + Lucide icon picker. Used by:
 *   - EslClient hangup handler (cause + billsec + direction → status)
 *   - syncCallToChat (status → label stored in Message.content)
 *   - MessageFeed renderCallMessage (status → label + color + icon)
 *   - CallDetailDrawer (status → header icon)
 *
 * Why a single file: keeps "what does outbound NO_ANSWER look like" in
 * exactly one place. Adding a new status now means editing this file and
 * the Prisma enum — nothing else.
 */
export type CallDirection = 'inbound' | 'outbound'

/**
 * Mirror of the Prisma CallStatus enum (string values are stable for
 * historical rows, even if the enum grows). Keep in sync with
 * prisma/schema.prisma → enum CallStatus.
 */
export type CallStatusValue =
    | 'ringing'    // call placed, not answered yet
    | 'active'     // bridged, conversation in progress
    | 'completed'  // billsec > 0 (real conversation)
    | 'missed'     // INBOUND only: manager never picked up
    | 'no_answer'  // OUTBOUND: peer didn't pick up (ring timeout)
    | 'busy'       // peer line busy (USER_BUSY)
    | 'rejected'   // peer / manager explicitly declined (CALL_REJECTED)
    | 'cancelled'  // OUTBOUND: manager hit "Отбой" before peer answered (ORIGINATOR_CANCEL)
    | 'failed'     // technical failure (no route, codec, gateway, etc.)

/**
 * UI color theme for a finished-call pill / header.
 * - green = answered & conversation happened
 * - red   = something to pay attention to (missed inbound, peer didn't answer)
 * - gray  = neutral (you cancelled, technical failure)
 */
export type CallStatusColor = 'green' | 'red' | 'gray'

/** Lucide icon family — caller maps to actual import. */
export type CallStatusIcon = 'incoming' | 'outgoing' | 'missed' | 'failed'

/**
 * Map FreeSWITCH hangup cause + billsec + direction → Call.status enum.
 *
 * Direction matters because the same cause means different things:
 *   - NORMAL_CLEARING + billsec=0 + inbound  → 'missed' (manager didn't pick up)
 *   - NORMAL_CLEARING + billsec=0 + outbound → 'no_answer' (peer didn't pick up)
 *   - ORIGINATOR_CANCEL + outbound → 'cancelled' (manager hit Отбой)
 *   - ORIGINATOR_CANCEL + inbound  → 'missed' (peer hung up before manager picked up)
 */
export function mapHangupCauseToStatus(
    cause: string,
    billsec: number,
    direction: CallDirection,
): CallStatusValue {
    if (billsec > 0) return 'completed'
    switch (cause) {
        case 'ORIGINATOR_CANCEL':
            return direction === 'outbound' ? 'cancelled' : 'missed'
        case 'NO_ANSWER':
        case 'NO_USER_RESPONSE':
        case 'ALLOTTED_TIMEOUT':
        case 'RECOVERY_ON_TIMER_EXPIRE':
            return direction === 'outbound' ? 'no_answer' : 'missed'
        case 'NORMAL_CLEARING':
            // Clean hangup with no media exchanged — peer hung up while
            // ringing (or trunk closed mid-INVITE). Treat as miss-style.
            return direction === 'outbound' ? 'no_answer' : 'missed'
        case 'USER_BUSY':
            return 'busy'
        case 'CALL_REJECTED':
        case 'NORMAL_TEMPORARY_FAILURE':
            return 'rejected'
        default:
            return 'failed'
    }
}

/**
 * Russian label for the call pill / journal row. Pure function — no DOM.
 * For completed calls duration is appended as "Исходящий · 00:42".
 */
export function callStatusLabel(
    direction: CallDirection,
    status: CallStatusValue,
    durationSec: number | null | undefined,
): string {
    const sec = durationSec ?? 0
    if (status === 'completed' && sec > 0) {
        const mm = Math.floor(sec / 60).toString().padStart(2, '0')
        const ss = (sec % 60).toString().padStart(2, '0')
        return direction === 'inbound' ? `Входящий · ${mm}:${ss}` : `Исходящий · ${mm}:${ss}`
    }
    // In-flight: shouldn't normally render to a pill but be defensive.
    if (status === 'ringing') return direction === 'inbound' ? 'Входящий вызов' : 'Идёт дозвон…'
    if (status === 'active')  return direction === 'inbound' ? 'Входящий, идёт разговор' : 'Исходящий, идёт разговор'

    if (direction === 'inbound') {
        switch (status) {
            case 'missed':    return 'Пропущенный звонок'
            case 'rejected':  return 'Отклонён'
            case 'busy':      return 'Линия занята'
            case 'no_answer': return 'Пропущенный звонок' // legacy rows
            case 'cancelled': return 'Пропущенный звонок' // shouldn't happen for inbound
            case 'failed':    return 'Не удалось'
            case 'completed': return 'Входящий'           // 0-sec answered, edge case
        }
    } else {
        switch (status) {
            case 'no_answer': return 'Без ответа'
            case 'cancelled': return 'Отменён'
            case 'busy':      return 'Занято'
            case 'rejected':  return 'Отклонён абонентом'
            case 'missed':    return 'Без ответа' // legacy rows
            case 'failed':    return 'Не удалось'
            case 'completed': return 'Исходящий'         // 0-sec answered, edge case
        }
    }
    return 'Звонок'
}

/** Color for the pill/header background+text. */
export function callStatusColor(
    direction: CallDirection,
    status: CallStatusValue,
): CallStatusColor {
    if (status === 'completed') return 'green'
    if (status === 'active' || status === 'ringing') return 'green'
    // Red — needs user attention
    if (direction === 'inbound' && (status === 'missed' || status === 'no_answer')) return 'red'
    if (direction === 'outbound' && status === 'no_answer') return 'red'
    if (status === 'busy') return 'red'
    // Everything else (cancelled, rejected, failed) — neutral gray
    return 'gray'
}

/** Which Lucide icon family to render. */
export function callStatusIcon(
    direction: CallDirection,
    status: CallStatusValue,
): CallStatusIcon {
    if (status === 'failed') return 'failed'
    // Inbound that ended without conversation = missed-style icon
    if (direction === 'inbound' && status !== 'completed' && status !== 'active' && status !== 'ringing') {
        return 'missed'
    }
    return direction === 'inbound' ? 'incoming' : 'outgoing'
}
