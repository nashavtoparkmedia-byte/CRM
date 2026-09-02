import { describe, expect, it } from 'vitest'
import {
    AiCallCampaignContractValidationError,
    CONTROL_AI_CALL_CAMPAIGN_COMMAND_V1,
    CREATE_AI_CALL_CAMPAIGN_COMMAND_V1,
    LIST_AI_CALL_CAMPAIGNS_QUERY_V1,
    parseControlAiCallCampaignCommandV1,
    parseCreateAiCallCampaignCommandV1,
    parseListAiCallCampaignsQueryV1,
} from './ai-call-campaign-management'

function command() {
    return {
        contract: CREATE_AI_CALL_CAMPAIGN_COMMAND_V1,
        requestId: 'request-1',
        name: 'Qualification campaign',
        scenarioId: 'scenario-1',
        scheduledAt: null,
        concurrentLimit: 4,
        ratePerMinute: 30,
        maxAttempts: 3,
        retryBaseMs: 1_000,
        retryMaxMs: 8_000,
        audience: {
            sourceRef: 'manual:fixture',
            sourceVersion: 'v1',
            members: [{ targetRef: 'external-1', phoneE164: '+79990000001', label: 'Lead 1' }],
        },
    }
}

describe('AI call campaign public contracts', () => {
    it('accepts the exact bounded create command', () => {
        expect(parseCreateAiCallCampaignCommandV1(command())).toEqual(command())
    })

    it('fails closed on unsupported versions and extra provider fields', () => {
        expect(() => parseCreateAiCallCampaignCommandV1({
            ...command(), contract: 'calling.CreateAiCallCampaignCommand.v2',
        })).toThrowError(expect.objectContaining<Partial<AiCallCampaignContractValidationError>>({
            code: 'UNSUPPORTED_CONTRACT_VERSION',
        }))
        expect(() => parseCreateAiCallCampaignCommandV1({ ...command(), providerApiKey: 'secret' }))
            .toThrow(/unsupported campaign command field/)
    })

    it('rejects invalid phones, duplicate targets and unbounded list states', () => {
        expect(() => parseCreateAiCallCampaignCommandV1({
            ...command(),
            audience: { ...command().audience, members: [{ targetRef: 'x', phoneE164: '8999' }] },
        })).toThrow(/E\.164/)
        expect(() => parseCreateAiCallCampaignCommandV1({
            ...command(),
            audience: {
                ...command().audience,
                members: [
                    { targetRef: 'x', phoneE164: '+79990000001' },
                    { targetRef: 'x', phoneE164: '+79990000002' },
                ],
            },
        })).toThrow(/duplicated/)
        expect(() => parseListAiCallCampaignsQueryV1({
            contract: LIST_AI_CALL_CAMPAIGNS_QUERY_V1, state: 'provider_internal_state',
        })).toThrow(/state is invalid/)
    })

    it('accepts only explicit pause, resume and cancel commands', () => {
        expect(parseControlAiCallCampaignCommandV1({
            contract: CONTROL_AI_CALL_CAMPAIGN_COMMAND_V1,
            requestId: 'control-1',
            campaignId: 'campaign-1',
            action: 'pause',
        }).action).toBe('pause')
        expect(() => parseControlAiCallCampaignCommandV1({
            contract: CONTROL_AI_CALL_CAMPAIGN_COMMAND_V1,
            requestId: 'control-1',
            campaignId: 'campaign-1',
            action: 'force_complete',
        })).toThrow(/action is invalid/)
    })
})
