'use client'

import { useActionState, useEffect, useState } from 'react'
import type { UserIdentityV1 } from '@/contracts/identity-access/v1'
import { submitMobileLoginAction } from './actions'

const DEVICE_ID_STORAGE_KEY = 'yoko_mobile_device_id'

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
    const [state, formAction, pending] = useActionState(submitMobileLoginAction, { error: null })
    const [deviceId, setDeviceId] = useState('')

    useEffect(() => {
        setDeviceId(readOrCreateDeviceId())
    }, [])

    return (
        <form action={formAction} className="mt-6 space-y-3">
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

            {state?.error ? (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
                    {state.error}
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
