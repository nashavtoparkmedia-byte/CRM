'use server'

import { redirect } from 'next/navigation'
import {
    clearMobileSessionV1,
    establishMobileSessionV1,
} from '@/modules/identity-access/public/v1/mobile-session-auth'
import { normalizeMobileReturnTo } from '@/modules/identity-access/public/v1/mobile-session-credentials'

/**
 * Mobile login and logout.
 *
 * On success the operator is returned to the destination they were originally
 * asking for — which, after a notification tap on an expired session, is the
 * conversation gate for the chat they tapped. That is the whole "expired
 * session returns to the target after login" behaviour, and it lives here on
 * the server rather than being re-implemented in the shell.
 */
export async function submitMobileLoginAction(
    _previousState: { error: string | null } | null,
    formData: FormData,
): Promise<{ error: string | null }> {
    const next = normalizeMobileReturnTo(formData.get('next'))

    // The employee picks themself and types their own password; the operator
    // is whoever that password verifies (docs/design/mobile-personal-signin-v1.md).
    const result = await establishMobileSessionV1(
        formData.get('operatorId'),
        formData.get('password'),
        formData.get('deviceId'),
    )

    if (result.ok) redirect(next)

    switch (result.reason) {
        case 'invalid_device':
            return { error: 'Устройство не распознано. Переустановите приложение.' }
        case 'session_active':
            return { error: 'Сначала выйдите из текущей сессии.' }
        case 'busy':
        case 'unavailable':
        case 'issue_failed':
            return { error: 'Вход временно недоступен. Попробуйте позже.' }
        default:
            // refused and throttled: one answer, nothing about which part failed.
            return { error: 'Неверный пароль или вход временно ограничен.' }
    }
}

export async function submitMobileLogoutAction(): Promise<void> {
    await clearMobileSessionV1()
    redirect('/login/mobile')
}
