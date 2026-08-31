export type AiCallCampaignRuntimeMode = 'disabled' | 'simulated' | 'unsupported_live'

/**
 * Campaign dialing is fail-closed. This branch intentionally implements only
 * a deterministic local simulator; a live/provider value is observable but
 * can never be selected as a dial adapter.
 */
export function readAiCallCampaignRuntimeMode(
    value = process.env.AI_CALL_CAMPAIGN_RUNTIME_MODE,
): AiCallCampaignRuntimeMode {
    if (value === 'simulated') return 'simulated'
    if (value == null || value === '' || value === 'disabled') return 'disabled'
    return 'unsupported_live'
}
