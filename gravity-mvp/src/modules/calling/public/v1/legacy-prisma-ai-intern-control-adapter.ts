import { prisma } from '@/lib/prisma'
import {
    SAVE_AI_AGENT_CONFIG_COMMAND_V1,
} from '../../../../contracts/calling/v1'
import { createSaveAiAgentConfigHandlerV1 } from './ai-agent-config-handler'
import type { AiInternControlPortV1 } from './ai-intern-control-handler'
import { legacyPrismaAiAgentConfigPortV1 } from './legacy-prisma-ai-agent-config-adapter'

const saveAiAgentConfig = createSaveAiAgentConfigHandlerV1(legacyPrismaAiAgentConfigPortV1)

/** Exact owner adapter: one credential-free flag read and one boolean-only save. */
export const legacyPrismaAiInternControlPortV1: AiInternControlPortV1 = {
    async getInternEnabled() {
        const config = await prisma.aiAgentConfig.findUnique({
            where: { id: 'singleton' },
            select: { internEnabled: true },
        })
        return config?.internEnabled ?? null
    },

    async setInternEnabled(enabled) {
        await saveAiAgentConfig({
            contract: SAVE_AI_AGENT_CONFIG_COMMAND_V1,
            entries: [{ field: 'internEnabled', value: enabled }],
        })
    },
}
