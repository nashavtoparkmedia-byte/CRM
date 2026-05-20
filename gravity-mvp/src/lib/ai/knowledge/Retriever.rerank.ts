/**
 * AI Knowledge Core — LLM rerank call (PR3.3).
 *
 * Отдельный модуль для dynamic-import из Retriever.ts — `skipRerank=true`
 * не подтягивает этот файл вообще.
 *
 * Tolerant: возвращает null при любой ошибке. Caller (Retriever) видит
 * null и продолжает с deterministic-only ordering.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { prisma } from '@/lib/prisma'
import {
    RERANK_SYSTEM_PROMPT,
    buildRerankUserPrompt,
    parseRerankResponse,
    type RerankCandidate,
} from './retrievalPrompt'
import type { PrefilterCandidate } from './Retriever'

interface AgentConfigLite {
    provider:            string
    apiKey:              string | null
    classificationModel: string
}

async function loadAgentConfigLite(): Promise<AgentConfigLite | null> {
    try {
        const rows = await prisma.$queryRaw<any[]>`
            SELECT
                provider::text                  AS provider,
                "apiKeyEncrypted"               AS "apiKey",
                "classificationModel"
            FROM "AiAgentConfig" WHERE id = 'singleton' LIMIT 1
        `
        return rows[0] ?? null
    } catch {
        return null
    }
}

/**
 * LLM-вызов rerank через classificationModel (Haiku/4o-mini).
 * Возвращает null при сбое — caller fallback на deterministic ordering.
 */
export async function rerankRun(
    query: string,
    candidates: PrefilterCandidate[],
): Promise<{ selectedIds: string[]; usedModel: string } | null> {
    const config = await loadAgentConfigLite()
    if (!config || !config.apiKey) return null

    // БЕЗ excerpts и БЕЗ raw данных в payload.
    const rerankPayload: RerankCandidate[] = candidates.map(c => ({
        id:                 c.item.id,
        title:              c.item.title,
        canonicalStatement: c.item.canonicalStatement,
        verified:           c.item.isVerified,
        sourceCount:        c.item.sourceCount,
        safetyLevel:        c.item.safetyLevel,
    }))

    const userPrompt = buildRerankUserPrompt(query, rerankPayload)
    const model = config.classificationModel

    try {
        let raw: string | null = null
        if (config.provider === 'openai') {
            const res = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Content-Type':  'application/json',
                },
                body: JSON.stringify({
                    model,
                    response_format: { type: 'json_object' },
                    temperature: 0,
                    max_tokens:  500,
                    messages: [
                        { role: 'system', content: RERANK_SYSTEM_PROMPT },
                        { role: 'user',   content: userPrompt },
                    ],
                }),
            })
            if (!res.ok) return null
            const data: any = await res.json()
            raw = data?.choices?.[0]?.message?.content ?? null
        } else {
            // Anthropic prefill trick для JSON-mode.
            const res = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key':         config.apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type':      'application/json',
                },
                body: JSON.stringify({
                    model,
                    max_tokens: 500,
                    temperature: 0,
                    system: RERANK_SYSTEM_PROMPT,
                    messages: [
                        { role: 'user',      content: userPrompt },
                        { role: 'assistant', content: '{' },
                    ],
                }),
            })
            if (!res.ok) return null
            const data: any = await res.json()
            const tail: string = data?.content?.[0]?.text ?? ''
            raw = '{' + tail
        }
        if (!raw) return null
        const parsed = parseRerankResponse(raw)
        return { selectedIds: parsed.selectedIds, usedModel: model }
    } catch {
        return null
    }
}
