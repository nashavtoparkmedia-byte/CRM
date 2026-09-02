import { describe, expect, it } from 'vitest'
import { readAiCallCampaignRuntimeMode } from './ai-call-campaign-runtime-mode'

describe('AI call campaign runtime mode', () => {
    it('is disabled by default and enables the simulator only inside an explicit non-production proof', () => {
        expect(readAiCallCampaignRuntimeMode(undefined)).toBe('disabled')
        expect(readAiCallCampaignRuntimeMode('disabled')).toBe('disabled')
        expect(readAiCallCampaignRuntimeMode('simulated', 'test', '1')).toBe('simulated')
        expect(readAiCallCampaignRuntimeMode('simulated', 'development', '1')).toBe('simulated')
        expect(readAiCallCampaignRuntimeMode('simulated', 'test', undefined)).toBe('simulated_unavailable')
        expect(readAiCallCampaignRuntimeMode('simulated', 'production', '1')).toBe('simulated_unavailable')
    })

    it('rejects live and unknown adapter requests', () => {
        expect(readAiCallCampaignRuntimeMode('live')).toBe('unsupported_live')
        expect(readAiCallCampaignRuntimeMode('provider')).toBe('unsupported_live')
    })
})
