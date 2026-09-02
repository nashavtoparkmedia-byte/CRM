import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CREATE_AI_CALL_CAMPAIGN_COMMAND_V1 } from '@/contracts/calling/v1'

const mocks = vi.hoisted(() => ({
    getScenario: vi.fn(),
    findCreateIdentity: vi.fn(),
    createDraft: vi.fn(),
    freezeAudience: vi.fn(),
    schedule: vi.fn(),
    detail: vi.fn(),
}))

vi.mock('../internal/ai-calls/ai-call-campaign-prisma-adapter', () => ({
    aiCallCampaignPrismaPort: {
        createDraft: mocks.createDraft,
        findCreateIdentity: mocks.findCreateIdentity,
        freezeAudience: mocks.freezeAudience,
        schedule: mocks.schedule,
    },
}))
vi.mock('../internal/ai-calls/ai-call-campaign-product-prisma-adapter', () => ({
    aiCallCampaignProductPrismaPort: {
        detail: mocks.detail,
        getActiveScenario: mocks.getScenario,
        list: vi.fn(),
    },
}))

import { AiCallCampaignConflictError } from './ai-call-campaign'
import { createAiCallCampaignV1 } from './ai-call-campaign-product-operations'

const command = {
    contract: CREATE_AI_CALL_CAMPAIGN_COMMAND_V1,
    requestId: 'inactive-scenario-request',
    name: 'Inactive scenario campaign',
    scenarioId: 'inactive-scenario',
    scheduledAt: null,
    concurrentLimit: 1,
    ratePerMinute: 1,
    maxAttempts: 1,
    retryBaseMs: 1_000,
    retryMaxMs: 1_000,
    audience: {
        sourceRef: 'test',
        sourceVersion: 'v1',
        members: [{ targetRef: 'external-1', phoneE164: '+79990000001' }],
    },
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.findCreateIdentity.mockResolvedValue(null)
    mocks.createDraft.mockResolvedValue({ campaign: { state: 'draft' }, status: 'created' })
    mocks.freezeAudience.mockResolvedValue({ status: 'frozen' })
    mocks.schedule.mockResolvedValue({ status: 'scheduled' })
    mocks.detail.mockResolvedValue({ id: 'created-campaign', state: 'scheduled' })
})

describe('AI call campaign product operations', () => {
    it('rejects missing or inactive scenarios before campaign persistence', async () => {
        mocks.getScenario.mockResolvedValue(null)
        await expect(createAiCallCampaignV1(command, { id: 'actor-1' })).rejects.toMatchObject({
            code: 'scenario_not_found',
        })
        expect(mocks.getScenario).toHaveBeenCalledWith('inactive-scenario')
        expect(mocks.createDraft).not.toHaveBeenCalled()
    })

    it('replays an existing exact command without consulting mutable scenario state', async () => {
        mocks.findCreateIdentity.mockResolvedValue({ campaignId: 'existing-campaign', state: 'completed' })
        mocks.detail.mockResolvedValue({ id: 'existing-campaign', state: 'completed' })
        await expect(createAiCallCampaignV1(command, { id: 'actor-1' })).resolves.toMatchObject({
            id: 'existing-campaign',
            state: 'completed',
        })
        expect(mocks.getScenario).not.toHaveBeenCalled()
        expect(mocks.createDraft).not.toHaveBeenCalled()
    })

    it('resumes scheduling after a concurrent exact replay freezes the audience first', async () => {
        mocks.findCreateIdentity
            .mockResolvedValueOnce({ campaignId: 'campaign-1', state: 'draft' })
            .mockResolvedValueOnce({ campaignId: 'campaign-1', state: 'ready' })
        mocks.freezeAudience.mockResolvedValue({ status: 'duplicate' })
        mocks.detail.mockResolvedValue({ id: 'campaign-1', state: 'scheduled' })

        await expect(createAiCallCampaignV1(command, { id: 'actor-1' })).resolves.toMatchObject({
            id: 'campaign-1',
            state: 'scheduled',
        })

        expect(mocks.getScenario).not.toHaveBeenCalled()
        expect(mocks.freezeAudience).toHaveBeenCalledOnce()
        expect(mocks.findCreateIdentity).toHaveBeenCalledTimes(2)
        expect(mocks.schedule).toHaveBeenCalledOnce()
    })

    it('accepts only proven forward progress when a concurrent replay wins scheduling', async () => {
        mocks.findCreateIdentity
            .mockResolvedValueOnce({ campaignId: 'campaign-1', state: 'ready' })
            .mockResolvedValueOnce({ campaignId: 'campaign-1', state: 'running' })
        mocks.schedule.mockRejectedValue(new AiCallCampaignConflictError('campaign_not_ready', 'campaign is not ready'))
        mocks.detail.mockResolvedValue({ id: 'campaign-1', state: 'running' })

        await expect(createAiCallCampaignV1(command, { id: 'actor-1' })).resolves.toMatchObject({
            id: 'campaign-1',
            state: 'running',
        })
        expect(mocks.findCreateIdentity).toHaveBeenCalledTimes(2)
    })

    it('fails closed when scheduling reports a conflict without persisted progress', async () => {
        mocks.findCreateIdentity
            .mockResolvedValueOnce({ campaignId: 'campaign-1', state: 'ready' })
            .mockResolvedValueOnce({ campaignId: 'campaign-1', state: 'ready' })
        mocks.schedule.mockRejectedValue(new AiCallCampaignConflictError('campaign_not_ready', 'campaign is not ready'))

        await expect(createAiCallCampaignV1(command, { id: 'actor-1' })).rejects.toMatchObject({
            code: 'campaign_not_ready',
        })
    })
})
