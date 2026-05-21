/**
 * DB helpers for AI-call scenarios. Mirrors the access pattern used by
 * aiCallAnalysis/config.ts but supports multiple rows (admin can create
 * different scenarios — e.g. one for cold leads, one for win-back).
 *
 * On first read in a fresh database, auto-seeds the default scenario so
 * the settings page never shows an empty list.
 */

import { prisma } from '@/lib/prisma'
import type { AiCallScenarioConfig, AiCallScenarioQuestion } from './types'
import {
    DEFAULT_SCENARIO_NAME,
    DEFAULT_SCENARIO_DESCRIPTION,
    DEFAULT_SCENARIO_SYSTEM_PROMPT,
    DEFAULT_SCENARIO_QUESTIONS,
    DEFAULT_SCENARIO_TARGET_SEC,
} from './default-scenario'

// Prisma types for AiCallScenario are generated after `prisma generate`.
// Cast to `any` so this file compiles before the user runs migrations
// locally — same pattern as aiCallAnalysis/config.ts.
const db = prisma as any

function rowToConfig(row: any): AiCallScenarioConfig {
    return {
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
        systemPrompt: row.systemPrompt,
        questions: (row.questions as AiCallScenarioQuestion[]) ?? [],
        targetDurationSec: row.targetDurationSec ?? undefined,
    }
}

export async function listScenarios(opts?: { includeInactive?: boolean }): Promise<AiCallScenarioConfig[]> {
    const rows = await db.aiCallScenario.findMany({
        where: opts?.includeInactive ? undefined : { isActive: true },
        orderBy: { createdAt: 'asc' },
    })
    if (rows.length === 0) {
        // Auto-seed default scenario so settings UI is never empty.
        const seeded = await createScenario({
            name: DEFAULT_SCENARIO_NAME,
            description: DEFAULT_SCENARIO_DESCRIPTION,
            systemPrompt: DEFAULT_SCENARIO_SYSTEM_PROMPT,
            questions: DEFAULT_SCENARIO_QUESTIONS,
            targetDurationSec: DEFAULT_SCENARIO_TARGET_SEC,
        })
        return [seeded]
    }
    return rows.map(rowToConfig)
}

export async function getScenario(id: string): Promise<AiCallScenarioConfig | null> {
    const row = await db.aiCallScenario.findUnique({ where: { id } })
    return row ? rowToConfig(row) : null
}

export async function createScenario(input: {
    name: string
    description?: string
    systemPrompt: string
    questions: AiCallScenarioQuestion[]
    targetDurationSec?: number
}): Promise<AiCallScenarioConfig> {
    const row = await db.aiCallScenario.create({
        data: {
            name: input.name,
            description: input.description,
            systemPrompt: input.systemPrompt,
            questions: input.questions as any,
            targetDurationSec: input.targetDurationSec,
            isActive: true,
        },
    })
    return rowToConfig(row)
}

export async function updateScenario(
    id: string,
    patch: {
        name?: string
        description?: string
        systemPrompt?: string
        questions?: AiCallScenarioQuestion[]
        targetDurationSec?: number
        isActive?: boolean
    },
): Promise<AiCallScenarioConfig> {
    const row = await db.aiCallScenario.update({
        where: { id },
        data: {
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.description !== undefined && { description: patch.description }),
            ...(patch.systemPrompt !== undefined && { systemPrompt: patch.systemPrompt }),
            ...(patch.questions !== undefined && { questions: patch.questions as any }),
            ...(patch.targetDurationSec !== undefined && { targetDurationSec: patch.targetDurationSec }),
            ...(patch.isActive !== undefined && { isActive: patch.isActive }),
        },
    })
    return rowToConfig(row)
}

export async function deleteScenario(id: string): Promise<void> {
    // Soft delete — keep history for any past AI calls that reference it
    await db.aiCallScenario.update({
        where: { id },
        data: { isActive: false },
    })
}
