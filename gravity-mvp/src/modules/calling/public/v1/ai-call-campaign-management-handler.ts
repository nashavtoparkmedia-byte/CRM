import {
    parseControlAiCallCampaignCommandV1,
    parseCreateAiCallCampaignCommandV1,
    parseGetAiCallCampaignQueryV1,
    parseListAiCallCampaignsQueryV1,
} from '@/contracts/calling/v1'
import {
    controlAiCallCampaignV1,
    createAiCallCampaignV1,
    getAiCallCampaignV1,
    listAiCallCampaignsV1,
    type AiCallCampaignActorV1,
} from '../../application/ai-call-campaign-product-operations'

export const aiCallCampaignManagementV1 = {
    create(input: unknown, actor: AiCallCampaignActorV1) {
        return createAiCallCampaignV1(parseCreateAiCallCampaignCommandV1(input), actor)
    },
    list(input: unknown) {
        return listAiCallCampaignsV1(parseListAiCallCampaignsQueryV1(input))
    },
    get(input: unknown) {
        return getAiCallCampaignV1(parseGetAiCallCampaignQueryV1(input))
    },
    control(input: unknown, actor: AiCallCampaignActorV1) {
        return controlAiCallCampaignV1(parseControlAiCallCampaignCommandV1(input), actor)
    },
}
