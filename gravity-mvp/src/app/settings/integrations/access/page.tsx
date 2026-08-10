import { redirect } from 'next/navigation'
import { LockKeyhole } from 'lucide-react'
import { hasIntegrationAdminAccess, normalizeIntegrationAdminReturnTo } from '@/modules/identity-access/public/v1'
import { signInIntegrationAdmin } from './actions'

export const dynamic = 'force-dynamic'

interface IntegrationAccessPageProps {
    searchParams: Promise<{ next?: string; error?: string }>
}

export default async function IntegrationAccessPage({ searchParams }: IntegrationAccessPageProps) {
    const params = await searchParams
    const returnTo = normalizeIntegrationAdminReturnTo(params.next)
    if (await hasIntegrationAdminAccess()) redirect(returnTo)

    const errorMessage = params.error === 'unavailable'
        ? 'Доступ администратора не настроен на сервере. Операция закрыта.'
        : params.error === 'invalid'
            ? 'Неверные данные администратора.'
            : null

    return (
        <main className="min-h-screen bg-background px-4 py-8">
            <div className="mx-auto mt-16 w-full max-w-md rounded-2xl border bg-card p-6 shadow-sm">
                <div className="mb-5 flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <LockKeyhole size={19} />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold">Доступ к интеграциям</h1>
                        <p className="mt-1 text-sm text-muted-foreground">
                            Введите учётные данные администратора проекта. Выбор пользователя CRM не подтверждает личность.
                        </p>
                    </div>
                </div>

                {errorMessage && (
                    <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                        {errorMessage}
                    </p>
                )}

                <form action={signInIntegrationAdmin} className="space-y-4">
                    <input type="hidden" name="next" value={returnTo} />
                    <label className="block text-sm font-medium">
                        Пользователь
                        <input
                            name="username"
                            autoComplete="username"
                            required
                            maxLength={128}
                            className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-normal"
                        />
                    </label>
                    <label className="block text-sm font-medium">
                        Пароль
                        <input
                            name="password"
                            type="password"
                            autoComplete="current-password"
                            required
                            maxLength={4096}
                            className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-normal"
                        />
                    </label>
                    <button
                        type="submit"
                        className="h-10 w-full rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
                    >
                        Войти
                    </button>
                </form>
                <p className="mt-4 text-xs text-muted-foreground">
                    Сессия хранится только в защищённой HttpOnly cookie и истекает через 8 часов.
                </p>
            </div>
        </main>
    )
}
