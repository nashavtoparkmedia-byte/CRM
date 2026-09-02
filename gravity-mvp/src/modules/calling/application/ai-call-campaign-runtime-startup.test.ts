import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ log: vi.fn() }))

vi.mock('@/infrastructure/operations/operational-log', () => ({ operationalLogV1: mocks.log }))

import { startAiCallCampaignRuntimeV1 } from './ai-call-campaign-runtime-startup'

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
})

describe('AI call campaign runtime startup', () => {
    it('does not schedule disabled, live, or unapproved simulation modes', () => {
        const runJob = vi.fn(async () => undefined)
        vi.stubEnv('AI_CALL_CAMPAIGN_RUNTIME_MODE', 'disabled')
        expect(startAiCallCampaignRuntimeV1(runJob)).toBeNull()

        vi.stubEnv('AI_CALL_CAMPAIGN_RUNTIME_MODE', 'live')
        expect(startAiCallCampaignRuntimeV1(runJob)).toBeNull()

        vi.stubEnv('AI_CALL_CAMPAIGN_RUNTIME_MODE', 'simulated')
        vi.stubEnv('NODE_ENV', 'production')
        vi.stubEnv('YOKO_AI_CALL_CAMPAIGN_SIMULATION_PROOF', '1')
        expect(startAiCallCampaignRuntimeV1(runJob)).toBeNull()
        expect(runJob).not.toHaveBeenCalled()
    })

    it('registers only an explicit non-production simulation proof', async () => {
        vi.useFakeTimers()
        vi.stubEnv('AI_CALL_CAMPAIGN_RUNTIME_MODE', 'simulated')
        vi.stubEnv('NODE_ENV', 'test')
        vi.stubEnv('YOKO_AI_CALL_CAMPAIGN_SIMULATION_PROOF', '1')
        vi.stubEnv('AI_CALL_CAMPAIGN_INTERVAL_MS', '250')
        const runJob = vi.fn(async () => undefined)

        const interval = startAiCallCampaignRuntimeV1(runJob)
        expect(interval).not.toBeNull()
        expect(runJob).toHaveBeenCalledTimes(1)
        expect(runJob).toHaveBeenCalledWith('ai_call_campaign_runtime', expect.any(Function))

        await vi.advanceTimersByTimeAsync(250)
        expect(runJob).toHaveBeenCalledTimes(2)
        if (interval) clearInterval(interval)
    })
})
