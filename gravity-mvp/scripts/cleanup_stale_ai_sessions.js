// Periodic reaper for AI-call sessions that got stuck in a non-terminal
// `aiSessionStatus` and never reached /api/ai-calls/sessions/[id]/finalize.
//
// Why this exists
// ───────────────
// The lifecycle on the happy path is:
//   start → starting → greeting → active → (end_call|transfer) → finalize → ended
// When the bridge crashes (node process dies, WS disconnects, OOM, …) or
// finalize never lands (CRM unreachable / Redis offline during enqueue),
// the Call row stays at whatever non-terminal state the bridge last
// wrote — most commonly `active`. The CRM UI then keeps showing the call
// as "in progress" forever, dashboards mis-count, and recordings for
// those calls miss the post-processing step.
//
// There is no built-in heartbeat or max-session-duration in the bridge,
// and finalize is the only place that writes the terminal `ended` state.
// This script closes that gap: scan periodically, mark long-running
// non-terminal sessions as `failed`, and leave enough forensic trace
// in `metadata` so the next operator can understand WHY a record was
// touched without losing the prior state.
//
// Scope decisions baked in
// ────────────────────────
//   • Only `starting`, `greeting`, `active` are eligible. `transferring`
//     is intentionally excluded — SIP REFER + human pickup can take
//     several minutes in legitimate flows, false-positives there are
//     more painful than the residual stale-state risk.
//   • Default TTL is 30 minutes — well above the realistic upper bound
//     for a live AI-conversation (~3× p99 of normal duration) while
//     still small enough to bound UI staleness.
//   • Dry-run mode (`STALE_AI_SESSION_DRY_RUN=1`) prints what *would*
//     happen without touching the DB. Required for production first-run.
//   • All writes are merge-into-metadata (never blow away existing
//     `metadata.originateError` etc.) so forensic context is preserved.
//
// Usage
// ─────
//   node gravity-mvp/scripts/cleanup_stale_ai_sessions.js
//   STALE_AI_SESSION_TTL_MIN=45 node ...
//   STALE_AI_SESSION_DRY_RUN=1  node ...
//
// Exit codes:
//   0 — completed (zero or more rows updated)
//   1 — fatal error (DB unreachable, etc.)

'use strict'

const path = require('path')

// Eligible non-terminal states. `transferring` deliberately omitted —
// see the header comment above.
const STALE_ELIGIBLE_STATUSES = Object.freeze(['starting', 'greeting', 'active'])

// Tagged constant so anyone grep-ing for "why is this call hangupCause
// AI_SESSION_STALE_CLEANUP" lands here directly.
const STALE_HANGUP_CAUSE = 'AI_SESSION_STALE_CLEANUP'
const STALE_REASON_TAG = 'bridge_timeout_or_finalize_missing'

/**
 * Pure-function core. Injected dependencies make this testable without a
 * live Postgres: tests pass a fake `prisma` that mimics `call.findMany`
 * and `call.update` over an in-memory array.
 *
 * @param {Object}   deps
 * @param {Object}   deps.prisma  Object with `.call.findMany()` + `.call.update()`.
 * @param {Date}     deps.now     Reference timestamp. Tests inject a fixed Date;
 *                                CLI passes `new Date()`.
 * @param {number}   deps.ttlMin  Minutes a session may stay non-terminal
 *                                before it's considered stale.
 * @param {boolean}  deps.dryRun  When true, no writes are performed.
 *
 * @returns {Promise<{scanned: number, updated: number, dryRun: boolean, stale: Array}>}
 */
async function markStaleSessions({ prisma, now, ttlMin, dryRun }) {
    const cutoff = new Date(now.getTime() - ttlMin * 60_000)

    const stale = await prisma.call.findMany({
        where: {
            isAi: true,
            aiSessionStatus: { in: STALE_ELIGIBLE_STATUSES },
            startedAt: { lt: cutoff },
        },
        select: {
            id: true,
            aiSessionStatus: true,
            metadata: true,
            startedAt: true,
        },
    })

    if (dryRun) {
        return {
            scanned: stale.length,
            updated: 0,
            dryRun: true,
            stale,
        }
    }

    let updated = 0
    for (const call of stale) {
        // Merge-append into existing metadata so forensic context from
        // other code paths (start/route.ts writes `originateError` for
        // failed originates) isn't overwritten. Defensive null/wrong-type
        // handling because the DB column is just `Json?`.
        const baseMeta =
            call.metadata && typeof call.metadata === 'object' && !Array.isArray(call.metadata)
                ? call.metadata
                : {}

        await prisma.call.update({
            where: { id: call.id },
            data: {
                aiSessionStatus: 'failed',
                endedAt: now,
                hangupCause: STALE_HANGUP_CAUSE,
                metadata: {
                    ...baseMeta,
                    staleCleanupAt: now.toISOString(),
                    staleCleanupPreviousStatus: call.aiSessionStatus,
                    staleCleanupReason: STALE_REASON_TAG,
                },
            },
        })
        updated++
    }

    return {
        scanned: stale.length,
        updated,
        dryRun: false,
        stale,
    }
}

// ── CLI wrapper ─────────────────────────────────────────────────────────
// Kept intentionally thin: env parsing, Prisma lifecycle, one log line.
// All real behaviour lives in `markStaleSessions` above.

function parseTtlMin(raw) {
    if (raw == null || raw === '') return 30
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`STALE_AI_SESSION_TTL_MIN must be a positive number, got "${raw}"`)
    }
    return n
}

async function runCli() {
    const ttlMin = parseTtlMin(process.env.STALE_AI_SESSION_TTL_MIN)
    const dryRun = process.env.STALE_AI_SESSION_DRY_RUN === '1'

    // Require Prisma lazily so anyone running `node --check` or this
    // file from a context without the workspace installed gets a clearer
    // diagnostic than a node_modules-not-found pile.
    const { PrismaClient } = require(
        path.join(__dirname, '..', 'node_modules', '@prisma', 'client'),
    )
    const prisma = new PrismaClient()

    try {
        const result = await markStaleSessions({
            prisma,
            now: new Date(),
            ttlMin,
            dryRun,
        })

        if (dryRun) {
            console.log(
                `[stale-ai-session-cleanup] dry-run scanned=${result.scanned} ` +
                `stale=${result.scanned} wouldUpdate=${result.scanned} ttlMin=${ttlMin}`,
            )
        } else {
            console.log(
                `[stale-ai-session-cleanup] scanned=${result.scanned} ` +
                `stale=${result.scanned} updated=${result.updated} ttlMin=${ttlMin}`,
            )
        }
    } finally {
        await prisma.$disconnect()
    }
}

// Only enter CLI flow when invoked directly — keeps the module
// importable from the test harness without side-effects.
if (require.main === module) {
    runCli().catch(err => {
        console.error('FATAL:', err.message ?? err)
        process.exit(1)
    })
}

module.exports = {
    markStaleSessions,
    STALE_ELIGIBLE_STATUSES,
    STALE_HANGUP_CAUSE,
    STALE_REASON_TAG,
}
