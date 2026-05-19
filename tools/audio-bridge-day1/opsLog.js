// Tiny structured logger for the bridge. JSON-line per call, no
// transports, no abstractions, no framework — `process.stdout.write`
// for info/warn, `process.stderr.write` for error. Matches the CRM-side
// `gravity-mvp/src/lib/opsLog.ts` schema (`{level, event, ts, ...ctx}`)
// so an external aggregator (Loki / journalctl / a tail+jq pipeline)
// can stitch bridge and CRM streams together by `event` + timestamp.
//
// Deliberately a separate file, not a shared lib with CRM:
//   - The bridge is a separate runtime (no TS, no Next, no path alias).
//   - We don't want a coupling that breaks if CRM logger gains
//     transports / async sinks / OpenTelemetry. The bridge stays cheap.

'use strict'

/**
 * @param {'info'|'warn'|'error'} level
 * @param {string} event   — snake_case event tag (matches CRM patterns:
 *                           ai_call_state_changed, lifecycle_post_failed, …)
 * @param {object} [ctx]   — extra fields merged into the JSON line.
 */
function opsLog(level, event, ctx) {
    try {
        const entry = { level, event, ts: new Date().toISOString(), ...(ctx ?? {}) }
        const line = JSON.stringify(entry)
        if (level === 'error') process.stderr.write(line + '\n')
        else process.stdout.write(line + '\n')
    } catch {
        // Fail-safe — logging must never break business flow. The most
        // realistic cause of a throw here is `JSON.stringify` choking on
        // a circular `ctx` (e.g. someone passes a `ws` client by
        // mistake). The fallback uses `process.stderr.write` rather than
        // `console.error` for two reasons:
        //   1. `process.stderr.write` is a raw byte sink — it accepts a
        //      string with no internal serialisation, so it can't
        //      circularly-explode on the same payload.
        //   2. It doesn't depend on the global `console` object, which
        //      a misbehaving runtime could in theory shadow.
        // If even stderr.write fails (broken stdio?) — swallow. The
        // contract is «never crash the bridge».
        try {
            process.stderr.write(`[opsLog-fallback] level=${level} event=${event}\n`)
        } catch { /* swallow */ }
    }
}

module.exports = { opsLog }
