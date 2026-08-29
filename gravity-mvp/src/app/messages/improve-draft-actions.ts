'use server'

/**
 * PR-Т: Server action для кнопки «Улучшить с ИИ» в input.
 */
import { prisma } from '@/lib/prisma'
import {
    improveMessageDraftV1 as improveDraft,
    type MessageDraftImprovePresetV1 as ImprovePreset,
} from '@/modules/messaging/public/v1/draft-improvement'
import { getAiAgentProviderConfigV1 } from '@/modules/calling/public/v1/ai-agent-provider-capability'

export type ImproveResult =
    | { ok: true;  improved: string }
    | { ok: false; error: string }

export async function improveDraftAction(
    chatId: string,
    draft: string,
    preset: ImprovePreset,
): Promise<ImproveResult> {
    const t = draft.trim()
    if (!t) return { ok: false, error: 'Введите текст черновика' }
    if (t.length < 3) return { ok: false, error: 'Слишком короткий черновик — улучшать нечего' }

    // 1. Загрузить provider config (singleton AiAgentConfig)
    const providerConfig = await getAiAgentProviderConfigV1()
    const config = providerConfig && {
        provider: providerConfig.provider,
        apiKey: providerConfig.apiKeyEncrypted,
        model: providerConfig.responseModel,
    }
    if (!config?.apiKey) {
        return { ok: false, error: 'AI provider не настроен в /settings/ai' }
    }

    // 2. Контекст: последние 6 сообщений в чате
    const recent = await prisma.message.findMany({
        where: { chatId },
        orderBy: { sentAt: 'desc' },
        take: 6,
        select: { direction: true, content: true },
    })
    const recentMessages = recent
        .reverse()
        .filter(m => m.content && (m.direction === 'inbound' || m.direction === 'outbound'))
        .map(m => ({ direction: m.direction as 'inbound' | 'outbound', content: m.content }))

    // 3. Стиль общения из Ядра (раздел style/правила — берём первые 2-3 items)
    let styleGuide: string | null = null
    try {
        const styleItems = await prisma.$queryRaw<Array<{ canonicalStatement: string }>>`
            SELECT "canonicalStatement"
            FROM "AiKnowledgeItem"
            WHERE "isArchived" = false AND ("kind"::text = 'style' OR "kind"::text = 'rule')
            ORDER BY "verifiedAt" DESC NULLS LAST
            LIMIT 3
        `
        if (styleItems.length > 0) {
            styleGuide = styleItems.map(s => `— ${s.canonicalStatement}`).join('\n')
        }
    } catch {
        // schema может отличаться — стиль необязателен
    }

    // 4. LLM call
    try {
        const improved = await improveDraft({
            provider:        config.provider,
            model:           config.model ?? 'claude-sonnet-4-5',
            apiKey:          config.apiKey!,
            draft:           t,
            preset,
            recentMessages,
            styleGuide,
        })
        if (!improved.trim()) return { ok: false, error: 'AI вернул пустой ответ' }
        return { ok: true, improved }
    } catch (e: any) {
        console.error('[improveDraftAction] error:', e)
        return { ok: false, error: e?.message || 'Ошибка вызова AI' }
    }
}
