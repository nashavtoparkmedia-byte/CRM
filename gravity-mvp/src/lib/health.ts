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
//      `prisma` singleton; MinIO is probed through Calling's narrow
//      recording-storage public capability; Redis + FS-ESL use Node's
//      built-in `net` with a raw TCP probe (Redis uses length-delimited
//      RESP `AUTH` when configured, then requires `+PONG\r\n`).
//   5. `ms` is mandatory on every Check, success or failure, including
//      the timeout path (= wall-clock spent waiting).
//
// Returned Check shape (mirrors what the endpoint serialises):
//   { name: string, ok: boolean, ms: number, error?: string }

import net from 'node:net'
import { prisma } from '@/lib/prisma'
import { probeRecordingStorageV1 } from '@/modules/calling/public/v1/recording-storage'
import { composeHealthResponse, withCheckTimeout } from './health-helpers'
import { encodeRespCommand, redisHealthTarget } from './health-redis-helpers'

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
    let target: ReturnType<typeof redisHealthTarget>
    try {
        target = redisHealthTarget(process.env)
    } catch {
        return { name: 'redis', ok: false, ms: 0, error: 'configuration_invalid' }
    }
    return new Promise<Check>((resolve) => {
        const start = Date.now()
        const sock = net.createConnection({ host: target.host, port: target.port })
        let settled = false
        let phase: 'auth' | 'ping' = target.authParts ? 'auth' : 'ping'
        let buffered = ''
        const finish = (ok: boolean, error?: string) => {
            if (settled) return
            settled = true
            try { sock.destroy() } catch { /* ignore */ }
            resolve({ name: 'redis', ok, ms: Date.now() - start, ...(error ? { error } : {}) })
        }
        sock.once('connect', () => {
            sock.write(encodeRespCommand(target.authParts ?? ['PING']))
        })
        sock.on('data', (buf) => {
            if (settled) return
            buffered += buf.toString('utf8')
            if (buffered.length > 4096) return finish(false, 'response_too_large')
            const lineEnd = buffered.indexOf('\r\n')
            if (lineEnd < 0) return
            const line = buffered.slice(0, lineEnd)
            buffered = buffered.slice(lineEnd + 2)
            if (phase === 'auth') {
                if (line !== '+OK') return finish(false, 'authentication_failed')
                phase = 'ping'
                sock.write(encodeRespCommand(['PING']))
                return
            }
            if (line === '+PONG') finish(true)
            else finish(false, 'unexpected_response')
        })
        sock.once('error', (err) => finish(false, err.message))
        sock.once('close', () => finish(false, 'connection_closed'))
    })
}

// ─── MinIO / S3 ───────────────────────────────────────────────────────
async function pingMinio(): Promise<Check> {
    return probeRecordingStorageV1()
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
