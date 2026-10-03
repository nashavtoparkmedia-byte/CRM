import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
    parsePilotReadinessArgsV1,
    pilotReadinessExitCodeV1,
    pilotReadinessOutputV1,
} from './compensation-pilot-readiness'

/**
 * The operator command's arguments and, more importantly, its output.
 *
 * The command decides nothing: it names the gate whose result should set the
 * exit code, and it prints what the owner operation returned. The redaction
 * proof feeds the projection a report carrying every field the report must
 * never emit, and asserts none of them reaches stdout.
 */

describe('parsing the operator arguments', () => {
    it('requires the input gate unless told otherwise', () => {
        expect(parsePilotReadinessArgsV1([])).toEqual({ require: 'input', error: null })
    })

    it('reads either gate', () => {
        expect(parsePilotReadinessArgsV1(['--require', 'candidate'])).toEqual({ require: 'candidate', error: null })
        expect(parsePilotReadinessArgsV1(['--require', 'input'])).toEqual({ require: 'input', error: null })
    })

    it('refuses a gate it does not know, and a flag with no value', () => {
        expect(parsePilotReadinessArgsV1(['--require', 'both']).error).toBe('--require must be candidate or input')
        expect(parsePilotReadinessArgsV1(['--require']).error).toBe('--require needs a value')
        expect(parsePilotReadinessArgsV1(['--require', '--require']).error).toBe('--require needs a value')
    })

    it('refuses options and arguments it does not know', () => {
        expect(parsePilotReadinessArgsV1(['--activate']).error).toBe('unknown option --activate')
        // No park flag by design: the scope is the configured pilot scope.
        expect(parsePilotReadinessArgsV1(['--park', 'p1']).error).toBe('unknown option --park')
        expect(parsePilotReadinessArgsV1(['p1']).error).toBe('unexpected argument p1')
    })
})

/** Values that must never appear in an operator report. */
const FORBIDDEN = [
    'Иванов Иван Иванович',
    '+79990001122',
    '9901234567',
    'tg-driver-username',
    '123456789012',
    'ext-order-3f9a2b1c0d',
    'Session_id=abc',
    'secret-token-value',
]

const report = () => ({
    generatedAt: new Date('2026-09-20T12:00:00.000Z'),
    mode: 'write',
    configError: null,
    pilotParks: ['ext-park-yoko'],
    syncEvidence: 'not_persisted' as const,
    pilotCandidateReady: true,
    pilotInputReady: true,
    pilotCandidateProofComplete: true,
    pilotInputProofComplete: true,
    proofIncompleteReason: null,
    counts: {
        pilotParkDrivers: 3,
        populationTruncated: false,
        withExternalDriverProfileId: 3,
        withSelfEmployedTrue: 2,
        withSelfEmployedUnknown: 1,
        withHireDate: 2,
        factsGatePassed: 2,
        candidateReady: 1,
        inputReady: 1,
        candidatesReported: 1,
        candidatesTruncated: false,
    },
    parks: [{
        externalParkId: 'ext-park-yoko',
        parkAuthority: 'authoritative' as const,
        parkAuthorityCode: null,
        catalogueStatus: 'ready' as const,
        // Not part of the operator report.
        connectionId: 'conn-secret-1',
    }],
    candidates: [{
        driverId: 'driver-1',
        externalParkId: 'ext-park-yoko',
        firstMonthKey: '2026-09',
        pilotCandidateReady: true,
        pilotInputReady: true,
        catalogueStatus: 'ready' as const,
        counts: {
            catalogueOrderCount: 2,
            freshOrderCount: 2,
            freshUnclaimedOrderCount: 1,
            claimableOrderCount: 1,
            remainingBudgetKopecks: 100_000,
        },
        reasons: [],
        // Everything below is the kind of value that must never be printed.
        driverName: FORBIDDEN[0],
        phone: FORBIDDEN[1],
        licence: FORBIDDEN[2],
        username: FORBIDDEN[3],
        telegramId: FORBIDDEN[4],
        externalOrderId: FORBIDDEN[5],
        externalDriverProfileId: 'driver-profile-secret',
        cookie: FORBIDDEN[6],
        apiKey: FORBIDDEN[7],
    }],
    reasons: [{ gate: 'input' as const, code: 'no_cash_orders', count: 1 }],
})

describe('the sanitized operator output', () => {
    it('emits only the named operational fields', () => {
        const output = pilotReadinessOutputV1(report() as never)
        expect(Object.keys(output).sort()).toEqual([
            'candidates', 'configError', 'counts', 'generatedAt', 'mode',
            'parks', 'pilotCandidateProofComplete', 'pilotCandidateReady',
            'pilotInputProofComplete', 'pilotInputReady', 'pilotParks',
            'proofIncompleteReason', 'reasons', 'syncEvidence',
        ])
        expect(Object.keys((output.candidates as Array<Record<string, unknown>>)[0]).sort()).toEqual([
            'catalogueOrderCount', 'catalogueStatus', 'claimableOrderCount', 'driverId',
            'externalParkId', 'firstMonthKey', 'freshOrderCount', 'freshUnclaimedOrderCount',
            'pilotCandidateReady', 'pilotInputReady', 'reasons', 'remainingBudgetKopecks',
        ])
        expect(Object.keys((output.parks as Array<Record<string, unknown>>)[0]).sort()).toEqual([
            'catalogueStatus', 'externalParkId', 'parkAuthority', 'parkAuthorityCode',
        ])
    })

    it('emits no name, phone, licence, Telegram identity, order id or credential', () => {
        const serialized = JSON.stringify(pilotReadinessOutputV1(report() as never))
        for (const value of FORBIDDEN) expect(serialized).not.toContain(value)
        expect(serialized).not.toContain('driver-profile-secret')
        expect(serialized).not.toContain('conn-secret-1')
        for (const key of [
            'driverName', 'phone', 'licence', 'username', 'telegramId',
            'externalOrderId', 'externalDriverProfileId', 'cookie', 'apiKey', 'connectionId',
        ]) {
            expect(serialized).not.toContain(key)
        }
    })

    it('renders the instant as an ISO string and keeps the counts intact', () => {
        const output = pilotReadinessOutputV1(report() as never)
        expect(output.generatedAt).toBe('2026-09-20T12:00:00.000Z')
        expect(output.counts).toMatchObject({ candidateReady: 1, inputReady: 1 })
        expect(output.syncEvidence).toBe('not_persisted')
    })

    it('reports a candidate refused at Gate 1 with null order counts, not zeroes', () => {
        const refused = report()
        refused.candidates[0] = {
            ...refused.candidates[0],
            pilotCandidateReady: false,
            pilotInputReady: false,
            catalogueStatus: null as never,
            counts: null as never,
            reasons: ['telegram_park_mismatch'] as never,
        }
        const candidate = (pilotReadinessOutputV1(refused as never).candidates as Array<Record<string, unknown>>)[0]
        expect(candidate).toMatchObject({
            pilotCandidateReady: false,
            catalogueStatus: null,
            freshUnclaimedOrderCount: null,
            remainingBudgetKopecks: null,
            reasons: ['telegram_park_mismatch'],
        })
    })
})

describe('a truncated population is reported as unproven, not as a negative', () => {
    const truncated = () => {
        const r = report()
        r.counts.pilotParkDrivers = 5000
        r.counts.populationTruncated = true
        r.counts.candidateReady = 1
        r.counts.inputReady = 0
        return {
            ...r,
            pilotCandidateReady: true,
            pilotInputReady: false,
            pilotCandidateProofComplete: true,
            pilotInputProofComplete: false,
            proofIncompleteReason: 'population_truncated_proof_incomplete' as const,
        }
    }

    it('15. emits the truncation, the proof status and a stable reason', () => {
        const output = pilotReadinessOutputV1(truncated() as never)
        expect(output.pilotInputReady).toBe(false)
        expect(output.pilotInputProofComplete).toBe(false)
        expect(output.proofIncompleteReason).toBe('population_truncated_proof_incomplete')
        // The candidate gate WAS proven: existentially, one hit needs no more.
        expect(output.pilotCandidateReady).toBe(true)
        expect(output.pilotCandidateProofComplete).toBe(true)
        expect((output.counts as Record<string, unknown>).populationTruncated).toBe(true)
    })

    it('15b. exits non-zero for an unproven input gate, and only 0 when proven', () => {
        // Unproven is a non-success exactly like a proven negative.
        expect(pilotReadinessExitCodeV1(truncated(), 'input')).toBe(1)
        // The candidate gate was proven, so asking for that one succeeds.
        expect(pilotReadinessExitCodeV1(truncated(), 'candidate')).toBe(0)
        // A complete negative is also non-zero.
        expect(pilotReadinessExitCodeV1({
            pilotCandidateReady: false, pilotInputReady: false,
            pilotCandidateProofComplete: true, pilotInputProofComplete: true,
        }, 'candidate')).toBe(1)
        // And a proven pass is the only 0.
        expect(pilotReadinessExitCodeV1({
            pilotCandidateReady: true, pilotInputReady: true,
            pilotCandidateProofComplete: true, pilotInputProofComplete: true,
        }, 'input')).toBe(0)
    })

    it('15c. never reports a gate as proven-ready while its proof is incomplete', () => {
        // The one combination that must be impossible to present as a pass.
        expect(pilotReadinessExitCodeV1({
            pilotCandidateReady: true, pilotInputReady: true,
            pilotCandidateProofComplete: true, pilotInputProofComplete: false,
        }, 'input')).toBe(1)
    })

    it('16. still emits no PII once the proof fields are added', () => {
        const serialized = JSON.stringify(pilotReadinessOutputV1(truncated() as never))
        for (const value of FORBIDDEN) expect(serialized).not.toContain(value)
        expect(serialized).not.toContain('driver-profile-secret')
        expect(serialized).not.toContain('conn-secret-1')
    })
})

/**
 * The command must load in the real application runtime, not only under Vitest.
 *
 * This suite deliberately does not exercise the module by importing it: Vitest's
 * config stubs `server-only` with a sentinel plugin, so an in-process import
 * proves nothing about production. Instead it runs the documented invocation in a
 * child process, where that stub does not apply, and asserts the whole import
 * closure resolves against the same node_modules the application image ships.
 *
 * The regression this guards is real and was found by rehearsal: importing
 * telegram_channel's public barrel pulls in the messaging delivery capability,
 * whose closure reaches `import 'server-only'` — a module Next resolves at build
 * time and which is absent from the image. The command then died with
 * `Cannot find module 'server-only'` before doing anything.
 */
describe('the command loads in the production runtime', () => {
    const gravityRoot = path.resolve(__dirname, '..')

    it('runs with server-only genuinely absent, as in the application image', () => {
        // If this ever starts resolving, the test below stops proving anything, so
        // assert the precondition rather than assuming it.
        const requireFromRoot = createRequire(path.join(gravityRoot, 'package.json'))
        expect(() => requireFromRoot.resolve('server-only')).toThrow()

        // `--require bogus` fails argument parsing and returns before any database
        // connection, so this loads the entire closure and touches nothing.
        let status = 0
        let stdout = ''
        let stderr = ''
        try {
            stdout = execFileSync(
                process.execPath,
                ['node_modules/.bin/jiti', 'scripts/compensation-pilot-readiness.ts', '--require', 'bogus'],
                {
                    cwd: gravityRoot,
                    encoding: 'utf8',
                    env: { ...process.env, JITI_ALIAS: JSON.stringify({ '@': path.join(gravityRoot, 'src') }) },
                },
            )
        } catch (error) {
            const failure = error as { status?: number; stdout?: string; stderr?: string }
            status = failure.status ?? 1
            stdout = failure.stdout ?? ''
            stderr = failure.stderr ?? ''
        }

        // The command reached its own argument check, which only the loaded module can print.
        expect(stdout).toContain('--require must be candidate or input')
        expect(status).toBe(1)
        // And it did not die on an unresolvable module on the way there.
        expect(stderr).not.toContain('server-only')
        expect(stderr).not.toContain('MODULE_NOT_FOUND')
    }, 120_000)

    it('reaches the published Telegram read by file, not through the public barrel', () => {
        const source = requireSource()
        // The two published files the owner's own PostgreSQL proof binds.
        expect(source).toContain("public/v1/driver-telegram-park-link-handler.js'")
        expect(source).toContain("public/v1/legacy-prisma-driver-telegram-adapter.js'")
        // The barrel is what dragged in server-only; it must not come back.
        expect(source).not.toContain("modules/telegram-channel/public/v1/index.js'")
        // The contract it speaks is unchanged.
        expect(source).toContain('READ_DRIVER_TELEGRAM_PARK_LINKS_QUERY_V1')
    })

    function requireSource(): string {
        const requireFromRoot = createRequire(path.join(gravityRoot, 'package.json'))
        const fs = requireFromRoot('node:fs') as typeof import('node:fs')
        return fs.readFileSync(path.join(gravityRoot, 'scripts/compensation-pilot-readiness.ts'), 'utf8')
    }
})
