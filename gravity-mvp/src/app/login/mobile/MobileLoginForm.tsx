'use client'

import { useEffect, useRef, useState } from 'react'
import type { UserIdentityV1 } from '@/contracts/identity-access/v1'
import { submitMobileLoginAction } from './actions'

const DEVICE_ID_STORAGE_KEY = 'yoko_mobile_device_id'

/**
 * How long to wait for the sign-in to answer before giving the operator back
 * control of the form.
 *
 * A submission that never resolves used to leave the button reading "Вход…"
 * for ever with nothing said. That is what happened on a phone whose tunnel to
 * the test backend had died between loading the form and pressing the button:
 * the request left the device, reached nothing, and the pending state had no
 * way out. Twenty seconds is far longer than a real sign-in, which answers in
 * tens of milliseconds.
 */
const LOGIN_TIMEOUT_MS = 20_000

/**
 * Stable per-install identifier.
 *
 * It is random, carries nothing about the device or the person, and exists so
 * a later stage can bind a push registration to the session that created it.
 * Generated in the browser because the shell has no bridge operation for it —
 * the bridge stays as small as it is.
 */
function readOrCreateDeviceId(): string {
    try {
        const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY)
        if (existing && /^[A-Za-z0-9_-]{8,128}$/.test(existing)) return existing
        const bytes = new Uint8Array(16)
        window.crypto.getRandomValues(bytes)
        const generated = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
        window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, generated)
        return generated
    } catch {
        // Storage disabled: still return something well-formed so login works.
        return 'ephemeral-device'
    }
}

export default function MobileLoginForm({
    next,
    operators,
}: {
    next: string
    operators: UserIdentityV1[]
}) {
    const [deviceId, setDeviceId] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [pending, setPending] = useState(false)
    const inFlight = useRef(false)

    useEffect(() => {
        setDeviceId(readOrCreateDeviceId())
    }, [])

    /**
     * Submit with a bounded wait.
     *
     * Three things this deliberately does NOT do. It never treats a timeout as
     * a successful sign-in: an unanswered request leaves the operator signed
     * out and says so. It never retries on its own, because a submission that
     * may still be in flight must not be duplicated. And it never hides the
     * outcome: a rejection shows the server's message, a timeout shows a
     * connectivity message, and the two are not conflated.
     */
    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (inFlight.current) return

        const formData = new FormData(event.currentTarget)
        inFlight.current = true
        setPending(true)
        setError(null)

        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('login_timeout')), LOGIN_TIMEOUT_MS)
        })

        try {
            // A successful sign-in redirects from the server, so this promise
            // never settles on the happy path: the page navigates away and the
            // component unmounts. Only a rejection or a timeout lands here.
            const result = await Promise.race([
                submitMobileLoginAction(null, formData),
                timeout,
            ])
            if (result?.error) setError(result.error)
        } catch (cause) {
            setError(
                (cause as Error)?.message === 'login_timeout'
                    ? 'Сервер не ответил. Проверьте соединение и попробуйте ещё раз.'
                    : 'Не удалось связаться с сервером. Попробуйте ещё раз.',
            )
        } finally {
            if (timer) clearTimeout(timer)
            inFlight.current = false
            setPending(false)
        }
    }

    return (
        <form onSubmit={handleSubmit} className="mt-6 space-y-3">
            <input type="hidden" name="next" value={next} />
            <input type="hidden" name="deviceId" value={deviceId} />

            <label className="block">
                <span className="text-[13px] font-medium text-foreground">Сотрудник</span>
                <select
                    name="operatorId"
                    required
                    defaultValue=""
                    className="mt-1 min-h-[44px] w-full rounded-lg border border-border px-3 text-[15px] focus:border-primary focus:outline-none"
                >
                    <option value="" disabled>Выберите сотрудника</option>
                    {operators.map((user) => (
                        <option key={user.id} value={user.id}>
                            {user.firstName} {user.lastName} — {user.role}
                        </option>
                    ))}
                </select>
            </label>

            <label className="block">
                <span className="text-[13px] font-medium text-foreground">Логин</span>
                <input
                    name="username"
                    required
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="mt-1 min-h-[44px] w-full rounded-lg border border-border px-3 text-[15px] focus:border-primary focus:outline-none"
                />
            </label>

            <label className="block">
                <span className="text-[13px] font-medium text-foreground">Пароль</span>
                <input
                    name="password"
                    type="password"
                    required
                    autoComplete="current-password"
                    className="mt-1 min-h-[44px] w-full rounded-lg border border-border px-3 text-[15px] focus:border-primary focus:outline-none"
                />
            </label>

            {error ? (
                <p
                    role="alert"
                    className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive"
                >
                    {error}
                </p>
            ) : null}

            <button
                type="submit"
                disabled={pending || deviceId === ''}
                className="min-h-[44px] w-full rounded-lg bg-primary px-3 text-[15px] font-semibold text-white disabled:opacity-50"
            >
                {pending ? 'Вход…' : 'Войти'}
            </button>
        </form>
    )
}
