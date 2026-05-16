import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * POST /api/settings/ai-call-keys/test
 * Body: { provider: 'openai' | 'yandex' }
 *
 * Performs a lightweight connectivity check for the requested provider
 * using the credentials in process.env. Returns ok/error + a short
 * message that's shown next to the provider card in the settings UI.
 *
 * Why server-side (not client-side):
 *   - The keys must never reach the browser. The browser tells us which
 *     provider to test; the server uses its own env to issue the call
 *     and only the result (ok/error + masked diagnostics) is returned.
 *
 * Checks:
 *   - openai: GET https://api.openai.com/v1/models with Bearer auth.
 *     200 => ok. 401 => bad key. anything else => network/quota.
 *   - yandex: POST https://iam.api.cloud.yandex.net/iam/v1/tokens with
 *     { yandexPassportOauthToken: <key> } would fail for an API key, so
 *     we instead try the Yandex SpeechKit REST surface (HEAD on the
 *     short-audio endpoint with auth header) — a 4xx without 401 means
 *     the key is accepted by the gateway.
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
        const key = process.env.OPENAI_API_KEY
        if (!key) {
            return NextResponse.json({
                ok: false,
                error: 'no_key',
                message: 'OPENAI_API_KEY не задан в .env',
            })
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
                return NextResponse.json({
                    ok: true,
                    message: 'OpenAI принимает ключ (GET /v1/models — 200)',
                })
            }
            if (res.status === 401) {
                return NextResponse.json({
                    ok: false,
                    error: 'invalid_key',
                    message: 'OpenAI вернул 401 — ключ невалиден',
                })
            }
            return NextResponse.json({
                ok: false,
                error: 'http_error',
                message: `OpenAI вернул HTTP ${res.status}`,
            })
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return NextResponse.json({
                ok: false,
                error: 'network',
                message: `Сетевая ошибка: ${msg}`,
            })
        }
    }

    // provider === 'yandex'
    const key = process.env.YANDEX_API_KEY
    const folder = process.env.YANDEX_FOLDER_ID
    if (!key) {
        return NextResponse.json({
            ok: false,
            error: 'no_key',
            message: 'YANDEX_API_KEY не задан в .env',
        })
    }
    if (!folder) {
        return NextResponse.json({
            ok: false,
            error: 'no_folder',
            message: 'YANDEX_FOLDER_ID не задан — нужен для тарификации SpeechKit',
        })
    }
    try {
        // SpeechKit short-audio recognize REST. We send a single byte of audio
        // (PCM 8 kHz mono — minimal valid request). The point isn't to recognize
        // anything, but to see whether the gateway accepts the auth header.
        //  - 401 => bad key
        //  - 200 / 400 / 4xx with provider-specific code => key is accepted
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
            return NextResponse.json({
                ok: false,
                error: 'invalid_key',
                message: `Yandex вернул ${res.status} — ключ невалиден или folder/scope не совпадает`,
            })
        }
        // Любой другой код (включая 400 "audio too short") означает что
        // gateway принял авторизацию и достучался до SpeechKit.
        return NextResponse.json({
            ok: true,
            message: `Yandex SpeechKit принимает ключ (HTTP ${res.status})`,
        })
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return NextResponse.json({
            ok: false,
            error: 'network',
            message: `Сетевая ошибка: ${msg}`,
        })
    }
}
