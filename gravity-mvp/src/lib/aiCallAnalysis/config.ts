/**
 * Helper around the TelephonyAiConfig singleton (id = "singleton").
 *
 * On first read we auto-upsert the row with default rubric/options so the
 * UI never sees an empty form. Admins edit through
 * /settings/integrations/telephony-ai.
 */

import { prisma } from '@/lib/prisma'
import {
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_CRITERIA,
    DEFAULT_OUTCOME_OPTIONS,
    DEFAULT_SENTIMENT_OPTIONS,
    DEFAULT_NEXT_ACTION_OPTIONS,
    type CriterionConfig,
    type OptionConfig,
    type RubricConfig,
} from '@/lib/aiCallAnalysis/prompt'

export const DEFAULT_ANALYSIS_MODEL = process.env.OPENAI_ANALYSIS_MODEL ?? 'gpt-4o'

export interface TelephonyAiConfigShape extends RubricConfig {
    id: string
    enabled: boolean
    model: string
    systemPrompt: string
    updatedAt: Date
}

// Re-export so callers downstream don't need to import from prompt.ts.
export type { CriterionConfig, OptionConfig, RubricConfig }

function asArrayOf<T>(v: unknown, fallback: T[]): T[] {
    if (Array.isArray(v) && v.length > 0) return v as T[]
    return fallback
}

function normalize(row: any): TelephonyAiConfigShape {
    return {
        id: row.id,
        enabled: row.enabled,
        model: row.model,
        systemPrompt: row.systemPrompt,
        criteria: asArrayOf<CriterionConfig>(row.criteria, DEFAULT_CRITERIA),
        outcomeOptions: asArrayOf<OptionConfig>(row.outcomeOptions, DEFAULT_OUTCOME_OPTIONS),
        sentimentOptions: asArrayOf<OptionConfig>(row.sentimentOptions, DEFAULT_SENTIMENT_OPTIONS),
        nextActionOptions: asArrayOf<OptionConfig>(row.nextActionOptions, DEFAULT_NEXT_ACTION_OPTIONS),
        updatedAt: row.updatedAt,
    }
}

export async function getTelephonyAiConfig(): Promise<TelephonyAiConfigShape> {
    // Prisma client generation can lag behind schema in dev (Windows + held
    // DLL handles), so we cast to any for the new JSON columns. The actual
    // DB columns exist after `prisma db push`.
    const client = prisma as any
    const existing = await client.telephonyAiConfig.findUnique({ where: { id: 'singleton' } })
    if (existing) return normalize(existing)

    const created = await client.telephonyAiConfig.create({
        data: {
            id: 'singleton',
            enabled: true,
            model: DEFAULT_ANALYSIS_MODEL,
            systemPrompt: DEFAULT_SYSTEM_PROMPT,
            criteria: DEFAULT_CRITERIA as any,
            outcomeOptions: DEFAULT_OUTCOME_OPTIONS as any,
            sentimentOptions: DEFAULT_SENTIMENT_OPTIONS as any,
            nextActionOptions: DEFAULT_NEXT_ACTION_OPTIONS as any,
        },
    })
    return normalize(created)
}

export async function updateTelephonyAiConfig(patch: {
    enabled?: boolean
    model?: string
    systemPrompt?: string
    criteria?: CriterionConfig[]
    outcomeOptions?: OptionConfig[]
    sentimentOptions?: OptionConfig[]
    nextActionOptions?: OptionConfig[]
}): Promise<TelephonyAiConfigShape> {
    const client = prisma as any
    const updateData: any = {}
    if (patch.enabled !== undefined) updateData.enabled = patch.enabled
    if (patch.model !== undefined) updateData.model = patch.model
    if (patch.systemPrompt !== undefined) updateData.systemPrompt = patch.systemPrompt
    if (patch.criteria !== undefined) updateData.criteria = patch.criteria
    if (patch.outcomeOptions !== undefined) updateData.outcomeOptions = patch.outcomeOptions
    if (patch.sentimentOptions !== undefined) updateData.sentimentOptions = patch.sentimentOptions
    if (patch.nextActionOptions !== undefined) updateData.nextActionOptions = patch.nextActionOptions

    const row = await client.telephonyAiConfig.upsert({
        where: { id: 'singleton' },
        update: updateData,
        create: {
            id: 'singleton',
            enabled: patch.enabled ?? true,
            model: patch.model ?? DEFAULT_ANALYSIS_MODEL,
            systemPrompt: patch.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
            criteria: (patch.criteria ?? DEFAULT_CRITERIA) as any,
            outcomeOptions: (patch.outcomeOptions ?? DEFAULT_OUTCOME_OPTIONS) as any,
            sentimentOptions: (patch.sentimentOptions ?? DEFAULT_SENTIMENT_OPTIONS) as any,
            nextActionOptions: (patch.nextActionOptions ?? DEFAULT_NEXT_ACTION_OPTIONS) as any,
        },
    })
    return normalize(row)
}
