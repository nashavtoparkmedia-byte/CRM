// Per-dependency probes for the /api/health endpoint.
//
// Layered on top of `./health-helpers.js`:
//   - This module owns the I/O probes (Postgres / Redis / MinIO / FS-ESL).
//   - `health-helpers.js` owns the pure orchestration (timeout wrapper,
//     response composer) and is unit-tested independently.
//
// Architectural constraints from the approved PR scope:
//   1. FAST FAIL — every probe runs inside its own timeout AND the four
//      run concurrently via `Promise.allSettled`. One slow / hung
//      dependency cannot stall the endpoint.
//   2. Centralised timeout — `HEALTH_CHECK_TIMEOUT_MS` env override,
//      default 2000 ms. No magic numbers sprinkled across probes.
//   3. `fs_esl` probe is TCP-connect only. No ESL auth, no `bgapi
//      originate`, no SIP traffic, no live-call side effects.
//   4. No new SDKs / monitoring deps. Postgres uses the existing
//      `prisma` singleton; MinIO uses `@aws-sdk/client-s3` already
//      wired by `recordingProcessor.ts`; Redis + FS-ESL use Node's
//      built-in `net` with a raw TCP probe (Redis also speaks the
//      one-line `PING` RESP command — server replies `+PONG\r\n`).
//   5. `ms` is mandatory on every Check, success or failure, including
//      the timeout path (= wall-clock spent waiting).
//
// Returned Check shape (mirrors what the endpoint serialises):
//   { name: string, ok: boolean, ms: number, error?: string }

import net from 'node:net'
import { prisma } from '@/lib/prisma'
import { composeHealthResponse, withCheckTimeout } from './health-helpers'

type Check = { name: string; ok: boolean; ms: number; error?: string }

/**
 * Single source of truth for the per-check timeout. Tests can override
 * via the runHealthChecks `timeoutMs` argument; ops can override via
 * env without code changes.
 */
export const HEALTH_CHECK_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? 2000)

// ─── Postgres ─────────────────────────────────────────────────────────
async function pingPostgres(): Promise<Check> {
    const start = Date.now()
    try {
        // Cheapest round-trip Prisma can do. `$queryRaw` reuses the
        // existing connection pool, no extra client needed.
        await prisma.$queryRaw`SELECT 1`
        return { name: 'postgres', ok: true, ms: Date.now() - start }
    } catch (err: any) {
        return { name: 'postgres', ok: false, ms: Date.now() - start, error: err?.message ?? String(err) }
    }
}

// ─── Redis ────────────────────────────────────────────────────────────
async function pingRedis(): Promise<Check> {
    return new Promise<Check>((resolve) => {
        const start = Date.now()
        const host = process.env.REDIS_HOST ?? '127.0.0.1'
        const port = Number(process.env.REDIS_PORT ?? 6379)
        const sock = net.createConnection({ host, port })
        let settled = false
        const finish = (ok: boolean, error?: string) => {
            if (settled) return
            settled = true
            try { sock.destroy() } catch { /* ignore */ }
            resolve({ name: 'redis', ok, ms: Date.now() - start, ...(error ? { error } : {}) })
        }
        sock.once('connect', () => {
            // RESP inline command. A healthy redis replies `+PONG\r\n`.
            // We don't bother to parse RESP — substring match is enough
            // to differentiate «port is open and redis answers» from
            // «port is open but it's some other TCP service».
            sock.write('PING\r\n')
        })
        sock.once('data', (buf) => {
            const text = buf.toString('utf8')
            if (text.includes('PONG')) finish(true)
            else finish(false, `unexpected_response: ${text.slice(0, 60).replace(/\s+/g, ' ')}`)
        })
        sock.once('error', (err) => finish(false, err.message))
    })
}

// ─── MinIO / S3 ───────────────────────────────────────────────────────
async function pingMinio(): Promise<Check> {
    const start = Date.now()
    try {
        // Lazy-require: the SDK is heavy and shouldn't load on cold
        // boot of unrelated routes. `require()` inside the function
        // keeps the cost paid only when /api/health is hit.
        const { S3Client, HeadBucketCommand } =
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('@aws-sdk/client-s3') as typeof import('@aws-sdk/client-s3')

        const endpoint = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000'
        const Bucket = process.env.S3_BUCKET ?? 'recordings'
        const client = new S3Client({
            endpoint,
            region: process.env.S3_REGION ?? 'us-east-1',
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY ?? 'crmadmin',
                secretAccessKey: process.env.S3_SECRET_KEY ?? 'crmpassword123',
            },
            forcePathStyle: true,
        })
        await client.send(new HeadBucketCommand({ Bucket }))
        return { name: 'minio', ok: true, ms: Date.now() - start }
    } catch (err: any) {
        return { name: 'minio', ok: false, ms: Date.now() - start, error: err?.message ?? String(err) }
    }
}

// ─── FreeSWITCH ESL ───────────────────────────────────────────────────
async function pingFsEsl(): Promise<Check> {
    // TCP-connect only. We intentionally do NOT speak ESL: no auth
    // handshake, no `api`/`bgapi`, no events subscription. The point
    // is to know «is the port reachable and accepting TCP», not «can
    // we drive a call right now».
    return new Promise<Check>((resolve) => {
        const start = Date.now()
        const host = process.env.FS_ESL_HOST ?? '127.0.0.1'
        const port = Number(process.env.FS_ESL_PORT ?? 8021)
        const sock = net.createConnection({ host, port })
        let settled = false
        const finish = (ok: boolean, error?: string) => {
            if (settled) return
            settled = true
            try { sock.destroy() } catch { /* ignore */ }
            resolve({ name: 'fs_esl', ok, ms: Date.now() - start, ...(error ? { error } : {}) })
        }
        sock.once('connect', () => finish(true))
        sock.once('error', (err) => finish(false, err.message))
    })
}

/**
 * Run all four probes concurrently with independent timeouts.
 * `Promise.allSettled` guarantees no single check blocks the others;
 * the per-check `withCheckTimeout` guarantees no single check blocks
 * the endpoint past `timeoutMs`.
 */
export async function runHealthChecks(opts?: { timeoutMs?: number }): Promise<Check[]> {
    const t = opts?.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS
    const settled = await Promise.allSettled([
        withCheckTimeout('postgres', pingPostgres, t) as Promise<Check>,
        withCheckTimeout('redis',    pingRedis,    t) as Promise<Check>,
        withCheckTimeout('minio',    pingMinio,    t) as Promise<Check>,
        withCheckTimeout('fs_esl',   pingFsEsl,    t) as Promise<Check>,
    ])
    const names = ['postgres', 'redis', 'minio', 'fs_esl']
    // Belt-and-suspenders: `withCheckTimeout` already catches anything
    // throwable in the wrapped fn, so .rejected should never happen.
    // We still guard it so the endpoint never crashes 500.
    return settled.map((r, i) => {
        if (r.status === 'fulfilled') return r.value
        return { name: names[i], ok: false, ms: 0, error: 'unexpected_throw' }
    })
}

export { composeHealthResponse }
