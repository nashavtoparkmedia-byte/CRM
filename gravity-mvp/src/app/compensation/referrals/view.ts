/**
 * What the referral screens show, as plain data the browser receives, and
 * the words for every code the backend answers with. No logic decides
 * anything here: the backend decided, the screen only names it.
 */

export interface ReferralProfileView {
    driverId: string
    fullName: string
    phone: string | null
    licenseNumber: string | null
    parkName: string | null
    employment: string
    dismissed: boolean
}

export interface ReferralCandidateView {
    selectable: boolean
    personContactId: string | null
    displayName: string
    matchedBy: string[]
    merged: boolean
    unselectableReason: string | null
    profiles: ReferralProfileView[]
}

export interface ReferralInvitationView {
    attributionId: string
    source: 'telegram' | 'manager'
    state: string
    otherContactId: string | null
    otherName: string | null
    at: string
    recordedBy: string | null
    reason: string | null
    withdrawnAt: string | null
    withdrawnBy: string | null
    withdrawable: boolean
    version: number
}

export interface ReferralAccessEntryView {
    kind: string
    occurredAt: string
    operatorLabel: string | null
    system: boolean
    reason: string | null
    basis: string | null
    referralAttributionId: string | null
    stale: boolean
}

export interface ReferralAccessView {
    state: 'granted' | 'denied' | 'needs_review' | 'none'
    manualGrant: { since: string; basis: string | null; referralAttributionId: string | null; operatorLabel: string | null } | null
    referralEntitlement: { since: string; attributionId: string | null } | null
    history: ReferralAccessEntryView[]
}

export interface ReferralPersonView {
    personContactId: string
    displayName: string
    merged: boolean
    profiles: ReferralProfileView[]
    cashIdentity: 'confirmed' | 'not_confirmed' | 'merged' | 'busy'
    access: ReferralAccessView
    invited: ReferralInvitationView[]
    invitedBy: ReferralInvitationView[]
}

export type ReferralSearchResponse =
    | { status: 'ok'; candidates: ReferralCandidateView[]; truncated: boolean }
    | { status: 'refused'; reason: string }

export type ReferralPersonResponse =
    | { status: 'ok'; person: ReferralPersonView }
    | { status: 'refused'; reason: string }

export type ReferralWriteResponse =
    | { status: 'done'; code: string; attributionId?: string }
    | { status: 'refused'; reason: string; detail?: string | null }

export const INVITATION_STATE_LABELS: Record<string, string> = {
    recorded: 'закреплён менеджером',
    withdrawn: 'закрепление снято',
    qualified: 'засчитан по ссылке в Telegram',
    captured: 'перешёл по ссылке в Telegram',
    pending: 'ждёт подтверждения',
    needs_review: 'на проверке',
    not_qualified: 'пока не засчитан',
    rejected: 'отклонён',
}

export const MATCH_LABELS: Record<string, string> = {
    name: 'ФИО',
    phone: 'телефон',
    licence: 'ВУ',
}

export const ACCESS_STATE_LABELS: Record<ReferralAccessView['state'], string> = {
    granted: 'Есть бессрочный доступ к компенсации наличных',
    none: 'Бессрочного доступа нет',
    denied: 'Доступ запрещён менеджером',
    needs_review: 'Контакты водителя объединялись: доступ нужно записать заново',
}

export const BASIS_LABELS: Record<string, string> = {
    referral_program: 'Реферальная программа',
    manager_decision: 'Решение менеджера',
}

export const ACCESS_EVENT_LABELS: Record<string, string> = {
    manual_granted: 'Доступ предоставлен',
    manual_cleared: 'Доступ отозван',
    manual_denied: 'Доступ запрещён',
    referral_entitlement_granted: 'Доступ по ссылке в Telegram',
    referral_entitlement_revoked: 'Доступ по ссылке отозван',
}

export const CASH_IDENTITY_LABELS: Record<ReferralPersonView['cashIdentity'], string> = {
    confirmed: 'Профиль водителя для Cash подтверждён в контактах.',
    not_confirmed: 'Профиль водителя для Cash ещё не подтверждён в контактах: доступ начнёт действовать после подтверждения.',
    merged: 'Контакты водителя объединялись. Cash сейчас не принимает таких водителей, поэтому доступ им не выдаётся.',
    busy: 'Контакты сейчас заняты, состояние профиля не проверено. Откройте карточку ещё раз.',
}

export const UNSELECTABLE_LABELS: Record<string, string> = {
    no_contact: 'Профиль не привязан к контакту — выбрать нельзя',
    contact_unresolved: 'Контакт профиля не определён — выбрать нельзя',
}

/** Every refusal the backend gives, in the words a manager reads. */
export const REFUSAL_LABELS: Record<string, string> = {
    disabled: 'Реферальная программа в CRM ещё не включена.',
    not_authenticated: 'Войдите в CRM.',
    user_disabled: 'Учётная запись отключена.',
    user_identity_incomplete: 'Не удалось определить пользователя.',
    role_not_allowed: 'Раздел доступен менеджерам, руководителям и администраторам.',
    query_too_short: 'Введите ФИО, телефон (от 7 цифр) или номер ВУ.',
    query_too_long: 'Слишком длинный запрос.',
    person_unresolved: 'Водитель не найден в контактах.',
    staff_session_unavailable: 'Изменения пока недоступны: нужен подписанный вход сотрудника. Просмотр работает.',
    staff_session_invalid: 'Вход сотрудника не подтверждён. Войдите заново.',
    capability_missing: 'У вашей учётной записи нет права на это действие.',
    invalid_request: 'Запрос не распознан. Обновите страницу.',
    person_changed: 'Данные водителя изменились. Найдите водителя заново.',
    busy: 'Запись занята другой операцией. Повторите через минуту.',
    self_invitation: 'Это один и тот же человек: пригласить самого себя нельзя.',
    invitee_already_attributed: 'Этот водитель уже закреплён за другим пригласившим.',
    not_withdrawable: 'Это приглашение нельзя снять: оно не закреплено менеджером или уже снято.',
    comment_required: 'Опишите решение (не короче 10 символов).',
    invitation_not_found: 'Выбранное приглашение не найдено у этого водителя.',
    person_merged: 'Контакты водителя объединялись: Cash такого водителя не принимает, доступ не выдан.',
}

/** What a finished write says. */
export const DONE_LABELS: Record<string, string> = {
    recorded: 'Приглашение закреплено. Доступ к компенсации не изменился.',
    already_recorded: 'Это приглашение уже закреплено.',
    withdrawn: 'Закрепление снято. Выданный доступ не изменился.',
    already_withdrawn: 'Закрепление уже снято.',
    granted: 'Бессрочный доступ предоставлен.',
    already_granted: 'Бессрочный доступ уже есть.',
    revoked: 'Доступ отозван.',
    nothing_to_revoke: 'Отзывать нечего: бессрочного доступа нет.',
}

export function refusalText(reason: string): string {
    return REFUSAL_LABELS[reason] ?? 'Действие не выполнено.'
}

export function formatDateTime(iso: string | null): string {
    if (iso === null) return ''
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleString('ru-RU', { timeZone: 'Asia/Yekaterinburg', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
