/**
 * Operator command: open a compensation budget month, or raise its limit.
 *
 * This is the only sanctioned way to provision a month. It writes no SQL of its
 * own: it calls the fleet_operations owner operation, which decides everything
 * and takes the row lock. The month window and the submission deadline are
 * derived from the period key by the monetary core's own calendar.
 *
 * Creating is idempotent, raising a limit is monotonic, and lowering a limit or
 * reopening a closed month is refused.
 *
 * Usage (any TypeScript runner; jiti ships with the application image, so the
 * command runs where the application runs, with no extra dependency):
 *
 *   JITI_ALIAS='{"@":"/app/src"}' node node_modules/.bin/jiti \
 *     scripts/compensation-budget-period.ts --period 2026-09 --limit-rubles 5000 --dry-run
 *   JITI_ALIAS='{"@":"/app/src"}' node node_modules/.bin/jiti \
 *     scripts/compensation-budget-period.ts --period 2026-09 --limit-rubles 5000
 *   … --period 2026-09 --limit-kopecks 500000
 *
 * The alias is what lets the loader resolve the application's `@/…` imports;
 * point it at this checkout's `src` when running outside the image. `npx tsx`
 * works too where that runner is installed.
 *
 * --dry-run reads and plans without writing anything. The result is printed as
 * one JSON object; the exit code is 0 when the month is provisioned (or would
 * be) and 1 when the operation refused.
 */

import { ensureCompensationBudgetPeriodV1 } from '../src/modules/fleet-operations/public/v1/index.js'
import { KOPECKS_PER_RUBLE } from '../src/modules/fleet-operations/internal/compensation/compensation-money.js'

interface ParsedArgsV1 {
    periodKey: string | null
    limitKopecks: number | null
    dryRun: boolean
    error: string | null
}

export function parseBudgetPeriodArgsV1(argv: readonly string[]): ParsedArgsV1 {
    const parsed: ParsedArgsV1 = { periodKey: null, limitKopecks: null, dryRun: false, error: null }
    const value = (index: number, flag: string): string | null => {
        const next = argv[index + 1]
        if (next === undefined || next.startsWith('--')) {
            parsed.error = `${flag} needs a value`
            return null
        }
        return next
    }
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if (argument === '--dry-run') { parsed.dryRun = true; continue }
        if (argument === '--period') {
            const raw = value(index, '--period')
            if (raw === null) return parsed
            parsed.periodKey = raw
            index += 1
            continue
        }
        if (argument === '--limit-kopecks' || argument === '--limit-rubles') {
            const raw = value(index, argument)
            if (raw === null) return parsed
            if (!/^\d+$/u.test(raw)) {
                parsed.error = `${argument} must be a whole number`
                return parsed
            }
            const amount = Number(raw)
            // Rubles are a convenience for the operator; kopecks are the only
            // representation the monetary core knows.
            parsed.limitKopecks = argument === '--limit-rubles' ? amount * KOPECKS_PER_RUBLE : amount
            index += 1
            continue
        }
        if (argument.startsWith('--')) {
            parsed.error = `unknown option ${argument}`
            return parsed
        }
    }
    if (parsed.periodKey === null) parsed.error = parsed.error ?? '--period is required'
    else if (parsed.limitKopecks === null) parsed.error = parsed.error ?? '--limit-rubles or --limit-kopecks is required'
    return parsed
}

async function main(): Promise<void> {
    const args = parseBudgetPeriodArgsV1(process.argv.slice(2))
    if (args.error !== null) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: args.error }, null, 2)}\n`)
        process.exitCode = 1
        return
    }

    const result = await ensureCompensationBudgetPeriodV1({
        periodKey: args.periodKey,
        limitKopecks: args.limitKopecks,
        dryRun: args.dryRun,
    })

    process.stdout.write(`${JSON.stringify({
        ok: result.ok,
        dryRun: result.dryRun,
        outcome: result.outcome,
        refusal: result.refusal,
        period: result.period === null ? null : {
            periodKey: result.period.periodKey,
            state: result.period.state,
            periodStartsAt: result.period.periodStartsAt.toISOString(),
            periodEndsAt: result.period.periodEndsAt.toISOString(),
            submissionClosesAt: result.period.submissionClosesAt.toISOString(),
            limitKopecks: result.period.limitKopecks,
            reservedKopecks: result.period.reservedKopecks,
            settledKopecks: result.period.settledKopecks,
            remainingKopecks: result.period.remainingKopecks,
        },
    }, null, 2)}\n`)
    process.exitCode = result.ok ? 0 : 1
}

if (process.argv[1] && process.argv[1].endsWith('compensation-budget-period.ts')) {
    main().catch((error: unknown) => {
        process.stdout.write(`${JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : 'unknown failure',
        }, null, 2)}\n`)
        process.exitCode = 1
    })
}
