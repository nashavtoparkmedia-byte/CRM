import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aiCallCampaignSha256, type AiCallCampaignJson } from '../../application/ai-call-campaign'
import { AiCallFrozenScenarioError, verifiedFrozenScenario } from './ai-call-bridge-scenario-loader'

/**
 * A campaign freezes its scenario at creation. What a launched member actually hears
 * must be that snapshot — not whatever the mutable scenario row says by the time the
 * call is placed.
 */

const SCENARIO_REF = 'scenario-frozen-1'

function snapshot(overrides: Record<string, unknown> = {}) {
    return {
        version: 1,
        scenarioId: SCENARIO_REF,
        name: 'Frozen qualification',
        description: null,
        systemPrompt: 'FROZEN PROMPT: the text the campaign was created with.',
        questions: [{ text: 'q1', intentKeywords: ['a'] }],
        targetDurationSec: 120,
        outcomeSchema: null,
        greetingVariants: null,
        fragments: null,
        projectId: 'p1',
        projectName: 'Project',
        ...overrides,
    }
}

function fingerprintOf(value: Record<string, unknown>): string {
    return aiCallCampaignSha256(value as AiCallCampaignJson)
}

describe('frozen campaign scenario', () => {
    it('executes the snapshot the campaign froze', () => {
        const frozen = snapshot()
        const scenario = verifiedFrozenScenario({
            callAiScenarioId: SCENARIO_REF,
            scenarioRef: SCENARIO_REF,
            scenarioSnapshot: frozen,
            scenarioFingerprint: fingerprintOf(frozen),
        })
        expect(scenario).toEqual({
            id: SCENARIO_REF,
            name: 'Frozen qualification',
            systemPrompt: 'FROZEN PROMPT: the text the campaign was created with.',
            questions: [{ text: 'q1', intentKeywords: ['a'] }],
            targetDurationSec: 120,
        })
    })

    it('survives a later edit of the source scenario row', () => {
        // The snapshot is self-contained: nothing about resolution reads the row, so an
        // operator editing the live prompt afterwards cannot reach a launched member.
        const frozen = snapshot()
        const pinned = fingerprintOf(frozen)
        const edited = snapshot({ systemPrompt: 'EDITED AFTER THE FREEZE' })
        expect(fingerprintOf(edited)).not.toBe(pinned)
        expect(verifiedFrozenScenario({
            callAiScenarioId: SCENARIO_REF,
            scenarioRef: SCENARIO_REF,
            scenarioSnapshot: frozen,
            scenarioFingerprint: pinned,
        }).systemPrompt).toBe('FROZEN PROMPT: the text the campaign was created with.')
    })

    it('fails closed on a tampered snapshot rather than using live data', () => {
        const frozen = snapshot()
        const pinned = fingerprintOf(frozen)
        expect(() => verifiedFrozenScenario({
            callAiScenarioId: SCENARIO_REF,
            scenarioRef: SCENARIO_REF,
            scenarioSnapshot: snapshot({ systemPrompt: 'TAMPERED' }),
            scenarioFingerprint: pinned,
        })).toThrow(AiCallFrozenScenarioError)
    })

    it('fails closed when the snapshot names another scenario', () => {
        const frozen = snapshot({ scenarioId: 'other' })
        expect(() => verifiedFrozenScenario({
            callAiScenarioId: SCENARIO_REF,
            scenarioRef: SCENARIO_REF,
            scenarioSnapshot: frozen,
            scenarioFingerprint: fingerprintOf(frozen),
        })).toThrow(/frozen_scenario_identity_mismatch/)
    })

    it('fails closed when the Call was created for a different scenario', () => {
        const frozen = snapshot()
        expect(() => verifiedFrozenScenario({
            callAiScenarioId: 'a-different-scenario',
            scenarioRef: SCENARIO_REF,
            scenarioSnapshot: frozen,
            scenarioFingerprint: fingerprintOf(frozen),
        })).toThrow(/frozen_scenario_call_mismatch/)
    })

    it('fails closed on a missing snapshot or an empty prompt', () => {
        expect(() => verifiedFrozenScenario({
            callAiScenarioId: SCENARIO_REF,
            scenarioRef: SCENARIO_REF,
            scenarioSnapshot: null,
            scenarioFingerprint: 'x'.repeat(64),
        })).toThrow(/frozen_scenario_snapshot_missing/)
        const empty = snapshot({ systemPrompt: '' })
        expect(() => verifiedFrozenScenario({
            callAiScenarioId: SCENARIO_REF,
            scenarioRef: SCENARIO_REF,
            scenarioSnapshot: empty,
            scenarioFingerprint: fingerprintOf(empty),
        })).toThrow(/frozen_scenario_prompt_missing/)
    })
})

describe('bridge resolver route', () => {
    const source = readFileSync(
        join(process.cwd(), 'src/app/api/ai-calls/sessions/by-fs-uuid/[fsUuid]/route.ts'),
        'utf8',
    )

    it('authenticates the bridge before it touches params or data', () => {
        const handler = source.slice(source.indexOf('export async function GET'))
        const guardAt = handler.indexOf('isBridgeMachineRequestAuthenticated(req.headers)')
        expect(guardAt).toBeGreaterThanOrEqual(0)
        for (const operation of ['await ctx.params', 'resolveBridgeCallScenarioV1', 'getScenario(']) {
            expect(guardAt).toBeLessThan(handler.indexOf(operation))
        }
    })

    it('prefers the frozen snapshot and keeps the live path for every other call', () => {
        expect(source).toContain('resolution?.frozenScenario ?? null')
        expect(source).toContain('if (!scenario && call.aiScenarioId)')
        expect(source).toContain('AiCallFrozenScenarioError')
    })
})
