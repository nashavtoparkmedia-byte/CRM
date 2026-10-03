/**
 * Operator command: the read-only cash-order preflight.
 *
 * This is the authorization probe of the release sequence
 * off → preflight → write. It reads authoritative park metadata, binds a real
 * credential, calls the provider over canonical windows derived from the
 * database's own clock, classifies every order with the writer's own rules, and
 * persists nothing whatsoever. It refuses to run while ingestion is already in
 * write mode.
 *
 * It writes no SQL of its own and holds no credential: it calls the
 * fleet_operations owner operation, which is composed with a persistence
 * capability one read method wide.
 *
 * Usage (any TypeScript runner; jiti ships with the application image, so the
 * command runs where the application runs, with no extra dependency):
 *
 *   JITI_ALIAS='{"@":"/app/src"}' node node_modules/.bin/jiti \
 *     scripts/compensation-cash-order-preflight.ts
 *   … --park <externalParkId>            probe one configured park
 *   … --park <a> --park <b>              probe a bounded subset
 *
 * With no --park the whole configured scope is probed. A park outside
 * YOKO_CASH_COMPENSATION_PARKS is refused rather than silently added.
 *
 * The result is one JSON object on stdout. Exit 0 means, and only means, that
 * every probed park is technically sufficient to authorize write mode; exit 1
 * covers every refusal, provider failure, throttle, truncation and
 * insufficiency. Authorizing write mode remains a human decision, and
 * PILOT INPUT READY is a separate later gate.
 */

import { preflightCashOrderIngestionV1 } from '../src/modules/fleet-operations/public/v1/index.js'

interface ParsedArgsV1 {
    parks: string[]
    error: string | null
}

export function parseCashOrderPreflightArgsV1(argv: readonly string[]): ParsedArgsV1 {
    const parsed: ParsedArgsV1 = { parks: [], error: null }
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if (argument === '--park') {
            const value = argv[index + 1]
            if (value === undefined || value.startsWith('--')) {
                parsed.error = '--park needs a value'
                return parsed
            }
            const park = value.trim()
            if (park === '') {
                parsed.error = '--park needs a value'
                return parsed
            }
            if (!parsed.parks.includes(park)) parsed.parks.push(park)
            index += 1
            continue
        }
        if (argument.startsWith('--')) {
            parsed.error = `unknown option ${argument}`
            return parsed
        }
        parsed.error = `unexpected argument ${argument}`
        return parsed
    }
    return parsed
}

async function main(): Promise<void> {
    const args = parseCashOrderPreflightArgsV1(process.argv.slice(2))
    if (args.error !== null) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: args.error }, null, 2)}\n`)
        process.exitCode = 1
        return
    }

    const report = await preflightCashOrderIngestionV1(
        args.parks.length > 0 ? { parks: args.parks } : {},
    )

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    // Exit 0 is the only signal an automated release step should trust, and it
    // is reserved for a probe that was technically sufficient.
    process.exitCode = report.sufficientToAuthorizeWriteMode ? 0 : 1
}

if (process.argv[1] && process.argv[1].endsWith('compensation-cash-order-preflight.ts')) {
    main().catch((error: unknown) => {
        // Fail closed and say nothing about the cause beyond its message: a
        // stack or a provider body could carry credential material.
        process.stdout.write(`${JSON.stringify({
            ok: false,
            sufficientToAuthorizeWriteMode: false,
            error: error instanceof Error ? error.message : 'unknown failure',
        }, null, 2)}\n`)
        process.exitCode = 1
    })
}
