/**
 * Helper around the TelephonyAiConfig singleton (id = "singleton") so call-site
 * code stays clean. Mirrors AiAgentConfig's pattern from settings/ai.
 *
 * The first read auto-upserts the row with defaults — that way the UI Settings
 * page can simply call getTelephonyAiConfig() without worrying about whether
 * the row exists yet.
 */

import { prisma } from '@/lib/prisma'
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/aiCallAnalysis/prompt'

// Default OpenAI model for call analysis. gpt-4o is the sweet spot for
// transcript scoring: strong enough to follow the 5-criterion rubric,
// fast enough for near-real-time turn-around. Admins can switch to
// gpt-4o-mini for cost or gpt-4-turbo for slightly older but tested
// behaviour via /settings/integrations/telephony-ai.
export const DEFAULT_ANALYSIS_MODEL = process.env.OPENAI_ANALYSIS_MODEL ?? 'gpt-4o'

export interface TelephonyAiConfigShape {
    id: string
    enabled: boolean
    model: string
    systemPrompt: string
    updatedAt: Date
}

export async function getTelephonyAiConfig(): Promise<TelephonyAiConfigShape> {
    // Prisma typing for the new model is generated after `prisma generate`;
    // we go through `any` here so the file compiles before the user runs
    // migrations + generate locally.
    const client = prisma as any
    const existing = await client.telephonyAiConfig.findUnique({ where: { id: 'singleton' } })
    if (existing) return existing as TelephonyAiConfigShape

    return (await client.telephonyAiConfig.create({
        data: {
            id: 'singleton',
            enabled: true,
            model: DEFAULT_ANALYSIS_MODEL,
            systemPrompt: DEFAULT_SYSTEM_PROMPT,
        },
    })) as TelephonyAiConfigShape
}

export async function updateTelephonyAiConfig(patch: {
    enabled?: boolean
    model?: string
    systemPrompt?: string
}): Promise<TelephonyAiConfigShape> {
    const client = prisma as any
    return (await client.telephonyAiConfig.upsert({
        where: { id: 'singleton' },
        update: patch,
        create: {
            id: 'singleton',
            enabled: patch.enabled ?? true,
            model: patch.model ?? DEFAULT_ANALYSIS_MODEL,
            systemPrompt: patch.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        },
    })) as TelephonyAiConfigShape
}
