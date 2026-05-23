'use server'

/**
 * PR-С: «AI учится из ответа оператора».
 *
 * После любого outbound (оператор отправил сообщение) сравниваем текст
 * с активным AiProposedReply (если был). Логика:
 *   - similarity ≥ 80% → оператор взял черновик AI (auto-verify items, без UI плашки)
 *   - similarity < 80% → AI был неточен, нужно учить → показываем banner
 *   - AI-черновика не было → silent skip (для MVP)
 *
 * Banner ведёт в существующий AiCoachModal (PR9.55) с initialCorrectedText=sentText.
 */
import { prisma } from '@/lib/prisma'
import { similarity } from '@/lib/ai/knowledge/textUtils'
import { confirmProposedReplyCorrect } from './proposed-reply-actions'

export type LearnResult =
    | { mode: 'auto_verified'; verifiedItems: number }
    | { mode: 'show_banner'; proposalId: string; aiText: string; similarityPct: number }
    | { mode: 'no_proposal' }
    | { mode: 'error'; error: string }

const SIMILARITY_THRESHOLD = 0.8  // 80%

export async function learnFromOutboundAction(
    chatId: string,
    sentText: string,
): Promise<LearnResult> {
    const text = sentText.trim()
    if (!text) return { mode: 'no_proposal' }

    try {
        // Найти recent active proposal — не expired, не dismissed, не taken-and-sent
        const proposal = await prisma.aiProposedReply.findFirst({
            where: {
                chatId,
                dismissedAt:        null,
                confirmedCorrectAt: null,
                expiresAt:          { gt: new Date(Date.now() - 30 * 60 * 1000) },  // 30 минут назад
            },
            // id (cuid) сортируется хронологически, prisma client может не знать про createdAt после rename
            orderBy: { id: 'desc' },
            select: { id: true, text: true },
        })

        if (!proposal) {
            return { mode: 'no_proposal' }
        }

        const sim = similarity(proposal.text || '', text)
        const simPct = Math.round(sim * 100)

        if (sim >= SIMILARITY_THRESHOLD) {
            // Оператор взял черновик AI с минимальными правками → auto-verify
            const r = await confirmProposedReplyCorrect(proposal.id)
            return { mode: 'auto_verified', verifiedItems: r.verifiedCount ?? 0 }
        }

        // Существенно отличается — показываем banner для запуска Coach
        return {
            mode:          'show_banner',
            proposalId:    proposal.id,
            aiText:        proposal.text || '',
            similarityPct: simPct,
        }
    } catch (e: any) {
        console.error('[learnFromOutboundAction] error:', e)
        return { mode: 'error', error: e?.message || 'unknown' }
    }
}
