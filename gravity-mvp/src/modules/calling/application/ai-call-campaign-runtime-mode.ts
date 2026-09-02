export type AiCallCampaignRuntimeMode =
    | 'disabled'
    | 'simulated'
    | 'simulated_unavailable'
    | 'unsupported_live'

/**
 * Campaign dialing is fail-closed. This branch intentionally implements only
 * a deterministic local simulator; a live/provider value is observable but
 * can never be selected as a dial adapter.
 */
export function readAiCallCampaignRuntimeMode(
    value = process.env.AI_CALL_CAMPAIGN_RUNTIME_MODE,
    environment = process.env.NODE_ENV,
    simulationProof = process.env.YOKO_AI_CALL_CAMPAIGN_SIMULATION_PROOF,
): AiCallCampaignRuntimeMode {
    if (value === 'simulated') {
        return environment !== 'production' && simulationProof === '1'
            ? 'simulated'
            : 'simulated_unavailable'
    }
    if (value == null || value === '' || value === 'disabled') return 'disabled'
    return 'unsupported_live'
}
