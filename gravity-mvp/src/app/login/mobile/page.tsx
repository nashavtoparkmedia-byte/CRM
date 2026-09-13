import { redirect } from 'next/navigation'
import { listUserIdentitiesV1 } from '@/modules/identity-access/public/v1/user-directory'
import {
    hasMobileSessionV1,
    isMobileLaneConfigured,
} from '@/modules/identity-access/public/v1/mobile-session-auth'
import { normalizeMobileReturnTo } from '@/modules/identity-access/public/v1/mobile-session-credentials'
import MobileLoginForm from './MobileLoginForm'

export const dynamic = 'force-dynamic'

export const metadata = {
    title: 'Вход · YOKO CRM',
}

/**
 * Entry screen for the Android shell.
 *
 * Unlike `/login`, which simply lets a visitor pick a name, this screen
 * requires a provisioned credential before it will issue anything. The
 * operator picker below it chooses which runtime identity the session acts
 * as; that choice is then signed into the session rather than left in a
 * cookie the client can rewrite.
 */
export default async function MobileLoginPage({
    searchParams,
}: {
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
    const resolved = await searchParams
    const next = normalizeMobileReturnTo(
        typeof resolved.next === 'string' ? resolved.next : undefined,
    )

    // Already signed in: honour the destination instead of asking again.
    if (await hasMobileSessionV1()) redirect(next)

    const configured = isMobileLaneConfigured()
    const operators = configured
        ? (await listUserIdentitiesV1()).filter((user) => user.status === 'Активен')
        : []

    return (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-white px-6">
            <div className="w-full max-w-sm">
                <h1 className="text-[20px] font-semibold text-foreground">YOKO CRM</h1>
                <p className="mt-1 text-[13px] text-muted">Вход в мобильное приложение</p>

                {configured ? (
                    <MobileLoginForm next={next} operators={operators} />
                ) : (
                    <p className="mt-6 rounded-md border border-border bg-surface p-4 text-[13px] text-foreground">
                        Мобильный вход не настроен на сервере. Нужны переменные
                        MOBILE_ACCESS_USER и MOBILE_ACCESS_PASS.
                    </p>
                )}
            </div>
        </div>
    )
}
