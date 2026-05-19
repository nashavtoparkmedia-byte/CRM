// GET /api/health/infra — infrastructure liveness for external
// monitors (Uptime Kuma, Pingdom, k8s probes, Docker HEALTHCHECK,
// systemd watchdogs, etc.).
//
// Separate from `/api/health` on purpose: that one is the
// messaging-focused snapshot (transport / pipeline / workflow / job
// state / runtime). This one is the bare infrastructure liveness for
// the AI-call stack — does the box reach Postgres, Redis, MinIO,
// FreeSWITCH ESL? — with a tight per-dep timeout and a simple status
// code monitors can alert on.
//
// INTENTIONALLY PUBLIC. This endpoint deliberately bypasses the auth
// layer: an external monitor doesn't carry a `crm_user_id` cookie, and
// requiring one would defeat the point. Any future security-hardening
// PR (signed cookies, middleware, real auth) MUST keep this route
// reachable anonymously.
//
// Response contract:
//   - 200 OK when every dependency check returned `ok: true`.
//   - 503 Service Unavailable otherwise (status='degraded' or 'down').
//   - Body always carries per-dependency breakdown with `ms` and,
//     on failure, `error`.
//
// The endpoint never throws upstream — `runHealthChecks` catches
// per-check exceptions and timeouts, and `composeHealthResponse` is
// a pure function. The outer try/catch is defense-in-depth.

import { NextResponse } from 'next/server'
import { runHealthChecks, composeHealthResponse } from '@/lib/health'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
    try {
        const checks = await runHealthChecks()
        const body = composeHealthResponse(checks)
        const httpStatus = body.status === 'ok' ? 200 : 503
        return NextResponse.json(body, { status: httpStatus })
    } catch (err: any) {
        // Should be unreachable — runHealthChecks is catch-all internally.
        // Still: fail closed with a structured body so the monitor gets
        // readable JSON instead of an HTML 500 page.
        return NextResponse.json(
            {
                status: 'down',
                ts: new Date().toISOString(),
                checks: [],
                error: err?.message ?? String(err),
            },
            { status: 503 },
        )
    }
}
