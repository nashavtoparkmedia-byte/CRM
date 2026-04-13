/**
 * Duplicate Execution Guard — database-based operation locking.
 *
 * Prevents concurrent execution of the same operation.
 * Lock expires automatically after timeout (no deadlocks).
 * Fail-safe: lock acquisition failure allows execution (degraded mode).
 */

import { prisma } from '@/lib/prisma'
import { opsLog } from '@/lib/opsLog'

let tableEnsured = false

const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Ensure execution_lock table exists. Idempotent, called once per process.
 */
async function ensureTable(): Promise<void> {
    if (tableEnsured) return
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS execution_lock (
                operation_name TEXT PRIMARY KEY,
                locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                expires_at TIMESTAMPTZ NOT NULL,
                locked_by TEXT
            )
        `)
        tableEnsured = true
    } catch {
        // Non-blocking: if table creation fails, locks degrade gracefully
    }
}

/**
 * Attempt to acquire an execution lock.
 * Returns true if lock acquired, false if already locked by another execution.
 *
 * Automatically cleans expired locks before attempting acquisition.
 */
export async function acquireLock(
    operationName: string,
    ttlMs: number = DEFAULT_LOCK_TTL_MS,
    lockedBy?: string
): Promise<boolean> {
    try {
        await ensureTable()

        // Clean expired locks and try to insert in one atomic operation
        // Using INSERT ... ON CONFLICT to ensure atomicity
        await prisma.$executeRawUnsafe(
            `DELETE FROM execution_lock WHERE operation_name = $1 AND expires_at < NOW()`,
            operationName
        )

        const result = await prisma.$executeRawUnsafe(
            `INSERT INTO execution_lock (operation_name, locked_at, expires_at, locked_by)
             VALUES ($1, NOW(), NOW() + INTERVAL '1 millisecond' * $2, $3)
             ON CONFLICT (operation_name) DO NOTHING`,
            operationName,
            ttlMs,
            lockedBy ?? null
        )

        // $executeRawUnsafe returns number of affected rows
        const acquired = (result as number) > 0

        if (!acquired) {
            opsLog('info', 'lock_blocked', { operation: operationName })
        }

        return acquired
    } catch (err: any) {
        // Fail-safe: if locking fails, allow execution (degraded mode)
        opsLog('warn', 'lock_acquire_failed', { operation: operationName, error: err.message })
        return true
    }
}

/**
 * Release an execution lock.
 * Safe to call even if lock was not acquired or already expired.
 */
export async function releaseLock(operationName: string): Promise<void> {
    try {
        await ensureTable()
        await prisma.$executeRawUnsafe(
            `DELETE FROM execution_lock WHERE operation_name = $1`,
            operationName
        )
    } catch {
        // Fail-safe: lock will expire naturally via TTL
    }
}

/**
 * Execute a function with an exclusive lock.
 * If the lock cannot be acquired, the function is skipped (returns null).
 *
 * Usage:
 *   const result = await withExclusiveLock('sync-trips', async () => {
 *       return await YandexFleetService.syncTrips(1)
 *   })
 *   if (result === null) console.log('Skipped — already running')
 */
export async function withExclusiveLock<T>(
    operationName: string,
    fn: () => Promise<T>,
    ttlMs: number = DEFAULT_LOCK_TTL_MS
): Promise<T | null> {
    const acquired = await acquireLock(operationName, ttlMs)
    if (!acquired) {
        opsLog('info', 'execution_skipped_locked', { operation: operationName })
        return null
    }

    try {
        return await fn()
    } finally {
        await releaseLock(operationName)
    }
}

/**
 * Check if an operation is currently locked (for health dashboard).
 */
export async function isLocked(operationName: string): Promise<boolean> {
    try {
        await ensureTable()
        const rows = await prisma.$queryRawUnsafe<Array<{ cnt: number }>>(
            `SELECT COUNT(*)::int as cnt FROM execution_lock
             WHERE operation_name = $1 AND expires_at > NOW()`,
            operationName
        )
        return (rows[0]?.cnt ?? 0) > 0
    } catch {
        return false
    }
}

/**
 * Get all active locks (for health dashboard).
 */
export async function getActiveLocks(): Promise<ActiveLock[]> {
    try {
        await ensureTable()
        return await prisma.$queryRawUnsafe<ActiveLock[]>(
            `SELECT operation_name as "operationName",
                    locked_at as "lockedAt",
                    expires_at as "expiresAt",
                    locked_by as "lockedBy"
             FROM execution_lock
             WHERE expires_at > NOW()
             ORDER BY locked_at DESC`
        )
    } catch {
        return []
    }
}

export interface ActiveLock {
    operationName: string
    lockedAt: Date
    expiresAt: Date
    lockedBy: string | null
}
