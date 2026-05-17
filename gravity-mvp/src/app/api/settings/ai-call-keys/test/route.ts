import { NextRequest, NextResponse } from 'next/server'
import { getValue, recordCheck } from '@/lib/ai-call/provider-settings'

export const dynamic = 'force-dynamic'

/**
 * POST /api/settings/ai-call-keys/test
 * Body: { provider: 'openai' | 'yandex' }
 *
 * Lightweight connectivity check for the requested provider using the
 * currently-stored key (DB row first, .env fallback). The browser never
 * sees the key — server issues the request and returns only the result.
 *
 * Result is also written back to the AiProviderSetting row
 * (lastCheckedAt / lastCheckStatus / lastCheckMessage) so it survives a
 * page reload.
 *
 * Checks:
 *   - openai: GET https://api.openai.com/v1/models with Bearer auth.
 *     200 → ok. 401 → bad key. anything else → network/quota.
 *   - yandex: POST https://stt.api.cloud.yandex.net/speech/v1/stt:recognize
 *     with auth + minimal audio body. 401/403 → bad key. anything else
 *     (including 400 "audio too short") → gateway accepted the auth.
 */
export async function POST(req: NextRequest) {
    const body = await req.json().catch(() => ({}))
    const provider = body.provider as 'openai' | 'yandex' | undefined

    if (provider !== 'openai' && provider !== 'yandex') {
        return NextResponse.json(
            { ok: false, error: 'unknown_provider', message: 'provider must be "openai" or "yandex"' },
            { status: 400 },
        )
    }

    if (provider === 'openai') {
        const key = await getValue('openai', 'apiKey')
        if (!key) {
            const result = { ok: false as const, error: 'no_key' as const, message: 'OpenAI API key не задан — добавь его в форме сверху' }
            await recordCheck('openai', 'apiKey', 'no_key', result.message)
            return NextResponse.json(result)
        }
        try {
            const ac = new AbortController()
            const t = setTimeout(() => ac.abort(), 10_000)
            const res = await fetch('https://api.openai.com/v1/models', {
                method: 'GET',
                headers: { Authorization: `Bearer ${key}` },
                signal: ac.signal,
            })
            clearTimeout(t)
            if (res.ok) {
                const msg = 'OpenAI принимает ключ (GET /v1/models — 200)'
                await recordCheck('openai', 'apiKey', 'ok', msg)
                return NextResponse.json({ ok: true, message: msg })
            }
            if (res.status === 401) {
                const msg = 'OpenAI вернул 401 — ключ невалиден'
                await recordCheck('openai', 'apiKey', 'invalid_key', msg)
                return NextResponse.json({ ok: false, error: 'invalid_key', message: msg })
            }
            const msg = `OpenAI вернул HTTP ${res.status}`
            await recordCheck('openai', 'apiKey', 'http_error', msg)
            return NextResponse.json({ ok: false, error: 'http_error', message: msg })
        } catch (err) {
            const m = err instanceof Error ? err.message : String(err)
            const msg = `Сетевая ошибка: ${m}`
            await recordCheck('openai', 'apiKey', 'network', msg)
            return NextResponse.json({ ok: false, error: 'network', message: msg })
        }
    }

    // provider === 'yandex'
    const [key, folder] = await Promise.all([
        getValue('yandex', 'apiKey'),
        getValue('yandex', 'folderId'),
    ])
    if (!key) {
        const msg = 'Yandex API key не задан — добавь его в форме сверху'
        await recordCheck('yandex', 'apiKey', 'no_key', msg)
        return NextResponse.json({ ok: false, error: 'no_key', message: msg })
    }
    if (!folder) {
        const msg = 'Yandex Folder ID не задан — нужен для тарификации SpeechKit'
        await recordCheck('yandex', 'apiKey', 'no_folder', msg)
        return NextResponse.json({ ok: false, error: 'no_folder', message: msg })
    }
    try {
        const url = `https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?folderId=${encodeURIComponent(folder)}&lang=ru-RU&sampleRateHertz=8000&format=lpcm`
        const ac = new AbortController()
        const t = setTimeout(() => ac.abort(), 10_000)
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Api-Key ${key}`,
                'Content-Type': 'application/octet-stream',
            },
            body: new Uint8Array([0]),
            signal: ac.signal,
        })
        clearTimeout(t)
        if (res.status === 401 || res.status === 403) {
            const msg = `Yandex вернул ${res.status} — ключ невалиден или folder/scope не совпадает`
            await recordCheck('yandex', 'apiKey', 'invalid_key', msg)
            return NextResponse.json({ ok: false, error: 'invalid_key', message: msg })
        }
        const msg = `Yandex SpeechKit принимает ключ (HTTP ${res.status})`
        await recordCheck('yandex', 'apiKey', 'ok', msg)
        return NextResponse.json({ ok: true, message: msg })
    } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        const msg = `Сетевая ошибка: ${m}`
        await recordCheck('yandex', 'apiKey', 'network', msg)
        return NextResponse.json({ ok: false, error: 'network', message: msg })
    }
}
