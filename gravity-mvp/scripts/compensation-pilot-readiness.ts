/**
 * Operator command: the read-only two-gate pilot readiness proof.
 *
 * It answers two separate questions about real data and changes nothing:
 *
 *   PILOT CANDIDATE READY  at least one real driver may be served by the pilot
 *                          at all — pilot park scope, provider identifiers,
 *                          park-SMZ, first calendar month, a bot link on that
 *                          same park, and one canonical person Contacts confirms.
 *   PILOT INPUT READY      at least one such driver additionally has something
 *                          to claim now — authoritative park, ready catalogue, a
 *                          fresh unclaimed order in their exact scope, and a
 *                          budget period that can cover a claim.
 *
 * Gate 1 is deliberately independent of budget, ingestion mode, catalogue and
 * orders, so it can pass immediately after migrations and the first Yandex fleet
 * sync, long before write mode is authorized.
 *
 * It performs no write of any kind, no provider request, no Yandex request and
 * no Telegram API request. It holds no credential and writes no SQL of its own:
 * it calls one fleet_operations owner operation, and binds Telegram channel's
 * own bounded public read into the seam Fleet declares for it — the same way the
 * application binds the Yandex reconciliation runner during bootstrap.
 *
 * There is no persisted marker in this repository for "the Yandex fleet sync
 * completed", so the report never claims one: it states
 * syncEvidence: "not_persisted" and proves readiness from the Driver facts the
 * sync would have written. Proving the sync itself ran is a separate step of the
 * release procedure.
 *
 * Usage (any TypeScript runner; jiti ships with the application image, so the
 * command runs where the application runs, with no extra dependency):
 *
 *   JITI_ALIAS='{"@":"/app/src"}' node node_modules/.bin/jiti \
 *     scripts/compensation-pilot-readiness.ts
 *   … --require candidate                exit 0 on Gate 1 alone
 *   … --require input                    exit 0 only on Gate 2 (the default)
 *
 * The result is one sanitized JSON object on stdout: internal driver ids, park
 * ids, month keys, bounded reason codes and counts. It never emits a driver
 * name, a phone number, a Telegram id or username, a raw external order id, or
 * any credential.
 *
 * Readiness is existential, so one qualifying driver proves a gate however much
 * of the population was read. A negative only proves the gate when the whole
 * population was read, and the population read is bounded, so the output
 * carries pilotCandidateProofComplete / pilotInputProofComplete beside each
 * verdict and a bounded proofIncompleteReason when a gate is unproven. Exit 0
 * means the requested gate was proven true; an unproven gate exits non-zero
 * exactly like a proven negative.
 */

import {
    READ_DRIVER_TELEGRAM_PARK_LINKS_QUERY_V1,
} from '../src/contracts/telegram-channel/v1/index.js'
import {
    compensationPilotReadinessV1,
    registerCompensationPilotTelegramLinkReaderV1,
} from '../src/modules/fleet-operations/public/v1/index.js'
// Imported by file rather than through telegram_channel's public barrel. The
// barrel re-exports the messaging delivery capability, whose closure reaches
// `import 'server-only'` — a module Next resolves at build time and which is not
// installed in the application image, so loading the barrel outside a Next build
// fails. These are the same two published files the owner's own PostgreSQL proof
// binds, so the contract this command speaks is unchanged.
import { createReadDriverTelegramParkLinksHandlerV1 } from '../src/modules/telegram-channel/public/v1/driver-telegram-park-link-handler.js'
import { legacyPrismaDriverTelegramParkLinkReadPortV1 } from '../src/modules/telegram-channel/public/v1/legacy-prisma-driver-telegram-adapter.js'

type RequiredGateV1 = 'candidate' | 'input'

interface ParsedArgsV1 {
    require: RequiredGateV1
    error: string | null
}

export function parsePilotReadinessArgsV1(argv: readonly string[]): ParsedArgsV1 {
    const parsed: ParsedArgsV1 = { require: 'input', error: null }
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if (argument === '--require') {
            const value = argv[index + 1]
            if (value === undefined || value.startsWith('--')) {
                parsed.error = '--require needs a value'
                return parsed
            }
            if (value !== 'candidate' && value !== 'input') {
                parsed.error = '--require must be candidate or input'
                return parsed
            }
            parsed.require = value
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

/**
 * The sanitized wire shape, built field by field.
 *
 * The owner operation already returns only these facts; projecting them again
 * here means a later widening of the owner DTO cannot start printing something
 * new, because a field nobody named below is simply not emitted.
 */
export function pilotReadinessOutputV1(
    report: Awaited<ReturnType<typeof compensationPilotReadinessV1>>,
): Record<string, unknown> {
    return {
        generatedAt: report.generatedAt.toISOString(),
        mode: report.mode,
        configError: report.configError,
        pilotParks: [...report.pilotParks],
        syncEvidence: report.syncEvidence,
        pilotCandidateReady: report.pilotCandidateReady,
        pilotInputReady: report.pilotInputReady,
        // A false gate above is only a proven negative when its proof is
        // complete. A truncated population reports not-proven, with a bounded
        // reason, so an unknown is never read as a complete negative.
        pilotCandidateProofComplete: report.pilotCandidateProofComplete,
        pilotInputProofComplete: report.pilotInputProofComplete,
        proofIncompleteReason: report.proofIncompleteReason,
        counts: {
            pilotParkDrivers: report.counts.pilotParkDrivers,
            populationTruncated: report.counts.populationTruncated,
            withExternalDriverProfileId: report.counts.withExternalDriverProfileId,
            withSelfEmployedTrue: report.counts.withSelfEmployedTrue,
            withSelfEmployedUnknown: report.counts.withSelfEmployedUnknown,
            withHireDate: report.counts.withHireDate,
            factsGatePassed: report.counts.factsGatePassed,
            candidateReady: report.counts.candidateReady,
            inputReady: report.counts.inputReady,
            candidatesReported: report.counts.candidatesReported,
            candidatesTruncated: report.counts.candidatesTruncated,
        },
        parks: report.parks.map((park) => ({
            externalParkId: park.externalParkId,
            parkAuthority: park.parkAuthority,
            parkAuthorityCode: park.parkAuthorityCode,
            catalogueStatus: park.catalogueStatus,
        })),
        candidates: report.candidates.map((candidate) => ({
            driverId: candidate.driverId,
            externalParkId: candidate.externalParkId,
            firstMonthKey: candidate.firstMonthKey,
            pilotCandidateReady: candidate.pilotCandidateReady,
            pilotInputReady: candidate.pilotInputReady,
            catalogueStatus: candidate.catalogueStatus,
            catalogueOrderCount: candidate.counts === null ? null : candidate.counts.catalogueOrderCount,
            freshOrderCount: candidate.counts === null ? null : candidate.counts.freshOrderCount,
            freshUnclaimedOrderCount: candidate.counts === null ? null : candidate.counts.freshUnclaimedOrderCount,
            claimableOrderCount: candidate.counts === null ? null : candidate.counts.claimableOrderCount,
            remainingBudgetKopecks: candidate.counts === null ? null : candidate.counts.remainingBudgetKopecks,
            reasons: [...candidate.reasons],
        })),
        reasons: report.reasons.map((reason) => ({
            gate: reason.gate,
            code: reason.code,
            count: reason.count,
        })),
    }
}

/**
 * The operator exit code, as a decision rather than an expression buried in
 * main, so the release semantics are testable.
 *
 * Exit 0 means the requested gate was PROVEN true. A gate that is false, and a
 * gate that is merely unproven because the population read was truncated, are
 * both non-success — the JSON says which, and an automated release step must
 * not treat "not disproven" as a pass.
 */
export function pilotReadinessExitCodeV1(
    report: Pick<
        Awaited<ReturnType<typeof compensationPilotReadinessV1>>,
        'pilotCandidateReady' | 'pilotInputReady' | 'pilotCandidateProofComplete' | 'pilotInputProofComplete'
    >,
    require: RequiredGateV1,
): 0 | 1 {
    const proven = require === 'input'
        ? report.pilotInputReady && report.pilotInputProofComplete
        : report.pilotCandidateReady && report.pilotCandidateProofComplete
    return proven ? 0 : 1
}

async function main(): Promise<void> {
    const args = parsePilotReadinessArgsV1(process.argv.slice(2))
    if (args.error !== null) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: args.error }, null, 2)}\n`)
        process.exitCode = 1
        return
    }

    // Fleet owns the seam; Telegram channel owns the read. Binding them here
    // keeps the manifest dependency graph acyclic and leaves the decision in
    // the owner operation, which this command does not duplicate.
    const readDriverTelegramParkLinksV1 = createReadDriverTelegramParkLinksHandlerV1(
        legacyPrismaDriverTelegramParkLinkReadPortV1,
    )
    registerCompensationPilotTelegramLinkReaderV1(async (driverIds) => {
        const result = await readDriverTelegramParkLinksV1({
            contract: READ_DRIVER_TELEGRAM_PARK_LINKS_QUERY_V1,
            driverIds: [...driverIds],
        })
        return result.links
    })

    const report = await compensationPilotReadinessV1()
    process.stdout.write(`${JSON.stringify(pilotReadinessOutputV1(report), null, 2)}\n`)
    process.exitCode = pilotReadinessExitCodeV1(report, args.require)
}

if (process.argv[1] && process.argv[1].endsWith('compensation-pilot-readiness.ts')) {
    main().catch((error: unknown) => {
        // Fail closed, and say nothing about the cause beyond its message.
        process.stdout.write(`${JSON.stringify({
            ok: false,
            pilotCandidateReady: false,
            pilotInputReady: false,
            error: error instanceof Error ? error.message : 'unknown failure',
        }, null, 2)}\n`)
        process.exitCode = 1
    })
}
