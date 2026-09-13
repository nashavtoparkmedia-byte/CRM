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

    const result = await establishMobileSessionV1(
        formData.get('username'),
        formData.get('password'),
        formData.get('operatorId'),
        formData.get('deviceId'),
    )

    if (result.ok) redirect(next)

    // One message for every credential-shaped failure: the form must not say
    // which half was wrong. Operator-shaped failures are distinguishable
    // because they are the operator's own selection, not a secret.
    switch (result.reason) {
        case 'not_configured':
            return { error: 'Мобильный вход не настроен на сервере. Обратитесь к администратору.' }
        case 'unknown_operator':
            return { error: 'Выберите сотрудника из списка.' }
        case 'inactive_operator':
            return { error: 'Учётная запись отключена.' }
        case 'invalid_device':
            return { error: 'Устройство не распознано. Переустановите приложение.' }
        default:
            return { error: 'Неверный логин или пароль.' }
    }
}

export async function submitMobileLogoutAction(): Promise<void> {
    await clearMobileSessionV1()
    redirect('/login/mobile')
}
