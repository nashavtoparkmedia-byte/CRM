import { describe, expect, it } from 'vitest'
import { readAiCallCampaignRuntimeMode } from './ai-call-campaign-runtime-mode'

describe('AI call campaign runtime mode', () => {
    it('is disabled by default and supports only the local simulator', () => {
        expect(readAiCallCampaignRuntimeMode(undefined)).toBe('disabled')
        expect(readAiCallCampaignRuntimeMode('disabled')).toBe('disabled')
        expect(readAiCallCampaignRuntimeMode('simulated')).toBe('simulated')
    })

    it('rejects live and unknown adapter requests', () => {
        expect(readAiCallCampaignRuntimeMode('live')).toBe('unsupported_live')
        expect(readAiCallCampaignRuntimeMode('provider')).toBe('unsupported_live')
    })
})
