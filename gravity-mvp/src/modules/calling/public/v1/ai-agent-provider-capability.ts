import { prisma } from '@/lib/prisma'

/** Owner-controlled AI provider capability. No ORM row or relation escapes. */
export type AiAgentProviderConfigV1 = {
    id: string
    enabled: boolean
    internEnabled: boolean
    mode: string
    provider: string
    apiKeyEncrypted: string | null
    classificationModel: string | null
    responseModel: string | null
    language: string | null
    confidenceThreshold: number
    maxAutoRepliesPerChat: number
    activeChannels: string[]
    extractionQualityTier: string | null
    extractionPromptVersion: string | null
    promptRole: string | null
    promptTone: string | null
    promptAllowed: string | null
    promptForbidden: string | null
    activeProfileId: string | null
}

const aiAgentProviderSelect = {
    id: true, enabled: true, internEnabled: true, mode: true, provider: true,
    apiKeyEncrypted: true, classificationModel: true, responseModel: true,
    language: true, confidenceThreshold: true, maxAutoRepliesPerChat: true, activeChannels: true,
    extractionQualityTier: true, extractionPromptVersion: true,
    promptRole: true, promptTone: true, promptAllowed: true, promptForbidden: true,
    activeProfileId: true,
} as const

export async function getAiAgentProviderConfigV1(): Promise<AiAgentProviderConfigV1 | null> {
    return prisma.aiAgentConfig.findUnique({ where: { id: 'singleton' }, select: aiAgentProviderSelect })
}
