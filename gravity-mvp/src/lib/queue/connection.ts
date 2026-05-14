/**
 * Shared ioredis connection for BullMQ producers + workers.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on the connection used by
 * workers (they hold a blocking BRPOPLPUSH and have their own retry loop).
 * One Redis client is reused for every queue / worker in this process to
 * avoid the connection-fan-out that BullMQ would otherwise create.
 *
 * Set REDIS_URL in gravity-mvp/.env (default: redis://127.0.0.1:6379) — that
 * matches the redis container exposed on loopback by telephony/docker-compose.yml.
 */

import IORedis, { type Redis, type RedisOptions } from 'ioredis'
import { opsLog } from '@/lib/opsLog'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

let connection: Redis | null = null
let lastErrorLoggedAt = 0

export function getRedisConnection(): Redis {
    if (connection) return connection

    const opts: RedisOptions = {
        // BullMQ contract — workers manage their own retry/backoff
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        // Don't crash the process if Redis is unreachable; queues will
        // retry by themselves and log via the 'error' handler below.
        lazyConnect: false,
        retryStrategy: (times: number) => Math.min(times * 1000, 30000),
    }

    connection = new IORedis(REDIS_URL, opts)

    connection.on('error', (err: Error) => {
        // Throttle to once per minute — ioredis spams on reconnect storms
        const now = Date.now()
        if (now - lastErrorLoggedAt < 60_000) return
        lastErrorLoggedAt = now
        opsLog('error', 'redis_connection_error', { operation: 'queue', error: err.message })
    })

    connection.on('connect', () => {
        opsLog('info', 'redis_connected', { operation: 'queue', url: REDIS_URL.replace(/\/\/.+@/, '//<auth>@') })
    })

    return connection
}

export async function closeRedisConnection(): Promise<void> {
    if (!connection) return
    await connection.quit().catch(() => connection?.disconnect())
    connection = null
}
