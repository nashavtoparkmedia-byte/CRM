import { describe, expect, it } from 'vitest'
import {
    AiCallCampaignConflictError,
    AiCallCampaignInputError,
    aiCallCampaignAttemptId,
    aiCallCampaignBackoffMs,
    aiCallCampaignLaunchId,
    aiCallCampaignRateIntervalMs,
    normalizeAiCallAudienceSnapshot,
    normalizeAiCallCampaignDraft,
} from './ai-call-campaign'

const draft = {
    campaignId: 'campaign-1',
    identityKey: 'owner-request-1',
    name: 'Qualification wave',
    scenarioRef: 'scenario-1',
    concurrentLimit: 2,
    ratePerMinute: 60,
    maxAttempts: 3,
    retryBaseMs: 1_000,
    retryMaxMs: 8_000,
}

describe('Calling mass-campaign domain', () => {
    it('normalizes a bounded deterministic draft identity', () => {
        const first = normalizeAiCallCampaignDraft(draft)
        const second = normalizeAiCallCampaignDraft(structuredClone(draft))
        expect(first.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/)
        expect(second.payloadFingerprint).toBe(first.payloadFingerprint)
    })

    it('materializes an immutable audience snapshot independent of input order', () => {
        const audience = {
            sourceKind: 'controlled_fixture',
            sourceRef: 'fixture-1',
            sourceVersion: 'v1',
            members: [
                { targetType: 'contact' as const, targetRef: 'c2', phoneE164: '+70000000002', provenance: { source: 'fixture' } },
                { targetType: 'contact' as const, targetRef: 'c1', phoneE164: '+70000000001', provenance: { source: 'fixture' } },
            ],
        }
        const left = normalizeAiCallAudienceSnapshot(draft.campaignId, audience)
        const right = normalizeAiCallAudienceSnapshot(draft.campaignId, {
            ...audience,
            members: [...audience.members].reverse(),
        })
        expect(left.fingerprint).toBe(right.fingerprint)
        expect(left.members.map((member) => member.targetRef)).toEqual(['c1', 'c2'])
        expect(Object.isFrozen(left.members)).toBe(true)
    })

    it('rejects duplicate logical audience members', () => {
        expect(() => normalizeAiCallAudienceSnapshot(draft.campaignId, {
            sourceKind: 'fixture', sourceRef: 'x', sourceVersion: 'v1',
            members: [
                { targetType: 'driver', targetRef: 'd1', phoneE164: '+70000000001', provenance: {} },
                { targetType: 'driver', targetRef: 'd1', phoneE164: '+70000000002', provenance: {} },
            ],
        })).toThrow(AiCallCampaignConflictError)
    })

    it('rejects non-E.164 target data at the Calling boundary', () => {
        expect(() => normalizeAiCallAudienceSnapshot(draft.campaignId, {
            sourceKind: 'fixture', sourceRef: 'x', sourceVersion: 'v1',
            members: [{ targetType: 'external', targetRef: 'e1', phoneE164: '123', provenance: {} }],
        })).toThrow(AiCallCampaignInputError)
    })

    it('bounds snapshot provenance size and nesting', () => {
        expect(() => normalizeAiCallAudienceSnapshot(draft.campaignId, {
            sourceKind: 'fixture', sourceRef: 'x', sourceVersion: 'v1',
            members: [{
                targetType: 'external', targetRef: 'e1', phoneE164: '+70000000001',
                provenance: { oversized: 'x'.repeat(4_096) },
            }],
        })).toThrow(AiCallCampaignInputError)
        let nested: Record<string, unknown> = { value: true }
        for (let depth = 0; depth < 10; depth += 1) nested = { nested }
        expect(() => normalizeAiCallAudienceSnapshot(draft.campaignId, {
            sourceKind: 'fixture', sourceRef: 'x', sourceVersion: 'v1',
            members: [{
                targetType: 'external', targetRef: 'e1', phoneE164: '+70000000001',
                provenance: nested as never,
            }],
        })).toThrow(AiCallCampaignInputError)
    })

    it('derives stable attempt and provider launch identities', () => {
        expect(aiCallCampaignAttemptId('member-1', 2)).toBe(aiCallCampaignAttemptId('member-1', 2))
        expect(aiCallCampaignLaunchId('member-1', 2)).toBe(aiCallCampaignLaunchId('member-1', 2))
        expect(aiCallCampaignLaunchId('member-1', 2)).not.toBe(aiCallCampaignLaunchId('member-1', 1))
    })

    it('uses explicit bounded exponential retry and independent rate intervals', () => {
        expect(aiCallCampaignBackoffMs({ attemptNumber: 1, retryBaseMs: 500, retryMaxMs: 1_500 })).toBe(500)
        expect(aiCallCampaignBackoffMs({ attemptNumber: 4, retryBaseMs: 500, retryMaxMs: 1_500 })).toBe(1_500)
        expect(aiCallCampaignRateIntervalMs(120)).toBe(500)
    })
})
