import { NextResponse } from 'next/server'
import net from 'net'
import { getCurrentUserIdentityV1 as getCurrentUser } from '@/modules/identity-access/public/v1/user-directory'
import { readMegafonTelephonyHealthV1 } from '@/modules/calling/public/v1/telephony-provider-health'

/**
 * GET /api/settings/telephony-status
 *
 * Live health snapshot for the telephony stack — what the operator sees
 * on /settings/integrations/telephony as coloured ticks. No secrets in
 * the response.
 *
 * Probes:
 *   - ESL connection (already established by instrumentation)
 *   - Megafon gateway registration via `sofia status gateway megafon`
 *   - SIP WS port (FreeSWITCH WebSocket for JsSIP)
 *   - VPN proxy (xray HTTP CONNECT)
 *   - Redis (BullMQ backbone)
 *   - MinIO (recordings storage)
 *   - OpenAI API key presence (we don't probe the API itself — see
 *     analyzeWorker / transcribeWorker for that)
 */

const DEFAULT_TIMEOUT_MS = 1500

function tcpProbe(host: string, port: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = new net.Socket()
        let settled = false
        const done = (ok: boolean) => {
            if (settled) return
            settled = true
            try { sock.destroy() } catch {}
            resolve(ok)
        }
        sock.setTimeout(timeoutMs)
        sock.once('connect', () => done(true))
        sock.once('timeout', () => done(false))
        sock.once('error', () => done(false))
        sock.connect(port, host)
    })
}

export async function GET() {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    // FreeSWITCH runs in its own container (or host) — reuse the same host the
    // ESL listener dials (FS_ESL_HOST), not loopback. Inside the gravity
    // container 127.0.0.1:7080 is nothing; the WS port listens on `freeswitch`.
    const wsHost = process.env.FS_ESL_HOST ?? '127.0.0.1'
    const wsPort = 7080  // FreeSWITCH WSS (JsSIP)
    const proxyEnv = process.env.HTTPS_PROXY || process.env.https_proxy || ''
    const proxyMatch = /^https?:\/\/([^:]+):(\d+)/i.exec(proxyEnv)
    const proxyHost = proxyMatch?.[1] ?? '127.0.0.1'
    const proxyPort = proxyMatch ? Number(proxyMatch[2]) : 10809

    const minioEnv = process.env.S3_ENDPOINT ?? ''
    const minioMatch = /^https?:\/\/([^:]+):?(\d+)?/i.exec(minioEnv)
    const minioHost = minioMatch?.[1] ?? '127.0.0.1'
    const minioPort = minioMatch?.[2] ? Number(minioMatch[2]) : (minioEnv.startsWith('https') ? 443 : 80)

    // REDIS_URL is redis://[user]:[pass]@host:port in production. The old
    // regex tripped on the empty-username form (redis://:pass@host) — `[^:]+`
    // stalls on the `:` right after `//` — and fell back to localhost, painting
    // a perfectly healthy Redis red. URL parsing handles every auth shape.
    let redisHost = '127.0.0.1'
    let redisPort = 6379
    try {
        const u = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379')
        if (u.hostname) redisHost = u.hostname
        if (u.port) redisPort = Number(u.port)
    } catch {}

    const [
        telephony,
        wsReachable,
        proxyReachable,
        redisReachable,
        minioReachable,
    ] = await Promise.all([
        readMegafonTelephonyHealthV1(),
        tcpProbe(wsHost, wsPort),
        tcpProbe(proxyHost, proxyPort),
        tcpProbe(redisHost, redisPort),
        tcpProbe(minioHost, minioPort),
    ])

    return NextResponse.json({
        ok: true,
        checks: {
            esl: { ok: telephony.eslConnected, label: 'FreeSWITCH ESL', detail: telephony.eslConnected ? 'подключено' : 'нет соединения' },
            megafon: {
                ok: telephony.megafonRegistrationState === 'REGED',
                label: 'Регистрация в МультиФон',
                detail: telephony.megafonRegistrationState ?? 'неизвестно',
            },
            sipWs: { ok: wsReachable, label: 'WebRTC SIP (порт 7080)', detail: wsReachable ? 'слушает' : 'не доступен' },
            proxy: {
                ok: proxyReachable,
                label: 'VPN-прокси для OpenAI',
                detail: proxyReachable ? `${proxyHost}:${proxyPort}` : (proxyEnv ? 'не доступен' : 'не настроен'),
            },
            redis: { ok: redisReachable, label: 'Redis (очередь BullMQ)', detail: redisReachable ? `${redisHost}:${redisPort}` : 'не доступен' },
            minio: { ok: minioReachable, label: 'MinIO (хранилище записей)', detail: minioReachable ? `${minioHost}:${minioPort}` : 'не доступен' },
            openaiKey: { ok: !!process.env.OPENAI_API_KEY, label: 'API-ключ OpenAI', detail: process.env.OPENAI_API_KEY ? 'установлен' : 'отсутствует' },
        },
    })
}
