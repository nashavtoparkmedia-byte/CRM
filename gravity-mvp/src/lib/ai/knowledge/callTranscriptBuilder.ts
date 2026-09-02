/**
 * AI Knowledge Core — call transcript builder (PR9.39).
 *
 * Аналог `pairBuilder.ts` для голосовых звонков. Берёт `Call.transcript`
 * (вывод Whisper) и упаковывает в `PromptPair`-совместимый объект,
 * чтобы Extractor мог обрабатывать звонки той же pipeline'ой что и
 * чаты — батчи по 8, parallel waves, LLM extraction, dedup и т.д.
 *
 * Особенности voice источника:
 *   - Один Call = один PromptPair (без турно-парной структуры —
 *     diarization пока не делаем, договорились с user'ом).
 *   - clientText = заглушка-маркер ("(голосовой звонок, разделение
 *     по ролям не выполнено)"), чтобы LLM знал контекст.
 *   - managerText = весь transcript — оттуда LLM извлекает факты,
 *     и `isVerbatimEvidence` проверяет cand.evidence_excerpt против
 *     него.
 *   - channel = 'phone' (уже есть в ChatChannel enum, не нужна
 *     миграция).
 *   - originType = 'voice_transcript' — это значение Extractor
 *     пробрасывает в AiKnowledgeSource.originType.
 *   - connectionId = 'voice_all' — виртуальный ID. На UI это
 *     отображается как один общий источник «Звонки», без разбиения
 *     по конкретным менеджерам / номерам.
 *
 * Filter:
 *   - transcript IS NOT NULL AND length > 50 (отсечь мусор от
 *     обрывков connection failure)
 *   - dateRange — переиспользуется тот же resolveDateRange что в
 *     pairBuilder (mode='last_30d' / 'last_90d' / 'all' / 'custom')
 *   - maxPairs (защитный потолок) разделяется с chat-пайплайном
 *     через scope.maxPairs (default 5000)
 *
 * НЕ ТРОГАЕТ existing pipeline — этот builder вызывается
 * параллельно с `buildPairs()` из `runExtraction`, результаты
 * объединяются в один массив pairs.
 */

import { prisma } from '@/lib/prisma'
import type { ExtractionScope, PromptPair } from './pairBuilder'

const DEFAULT_MAX_CALLS = 5000
const MIN_TRANSCRIPT_LENGTH = 50

function resolveDateRange(scope: ExtractionScope): { from: Date | null; to: Date | null } {
    const now = new Date()
    if (scope.mode === 'last_30d') {
        return { from: new Date(now.getTime() - 30 * 24 * 3600 * 1000), to: null }
    }
    if (scope.mode === 'last_90d') {
        return { from: new Date(now.getTime() - 90 * 24 * 3600 * 1000), to: null }
    }
    if (scope.mode === 'all') {
        return { from: null, to: null }
    }
    const f = scope.dateFrom ? new Date(scope.dateFrom) : null
    const t = scope.dateTo   ? new Date(scope.dateTo)   : null
    return { from: f, to: t }
}

interface CallRow {
    id:         string
    transcript: string
    startedAt:  Date
}

/**
 * Главный entry: возвращает все звонки с непустым transcript в виде
 * PromptPair[]. Если scope.channels задан и НЕ включает 'phone' —
 * возвращает пустой массив (звонки не выбраны).
 */
export async function buildCallChunks(scope: ExtractionScope): Promise<{
    pairs:        PromptPair[]
    callsScanned: number
}> {
    // Если channels filter активен и 'phone' там нет — звонки не нужны.
    if (scope.channels && scope.channels.length > 0 && !scope.channels.includes('phone')) {
        return { pairs: [], callsScanned: 0 }
    }
    const { from, to } = resolveDateRange(scope)
    const limit = scope.maxPairs ?? DEFAULT_MAX_CALLS

    const rows = await prisma.$queryRaw<CallRow[]>`
        SELECT id, transcript, "startedAt"
        FROM "Call"
        WHERE "isSimulation" = false
          AND transcript IS NOT NULL
          AND length(transcript) > ${MIN_TRANSCRIPT_LENGTH}
          AND (${from}::timestamp IS NULL OR "startedAt" >= ${from})
          AND (${to}::timestamp   IS NULL OR "startedAt" <= ${to})
        ORDER BY "startedAt" ASC
        LIMIT ${limit}
    `

    const pairs: PromptPair[] = rows.map(r => ({
        // Виртуальный chat-id чтобы не пересечься с реальными Chat.id.
        chatId:           `call:${r.id}`,
        channel:          'phone',
        // managerMessageId совпадает с Call.id — это soft-reference
        // (без FK по схеме AiKnowledgeSource.messageId), используется
        // для excerptHash и идемпотентности повторных запусков.
        clientMessageId:  `call_client:${r.id}`,
        managerMessageId: r.id,
        clientText:       '(голосовой звонок, разделение по ролям не выполнено)',
        managerText:      r.transcript,
        clientAt:         r.startedAt,
        managerAt:        r.startedAt,
        managerUserId:    null,
        // Виртуальный connectionId — один на все звонки. UI показывает
        // как «Звонки» (один общий источник без разбивки по менеджерам).
        connectionId:     'voice_all',
        originType:       'voice_transcript',
    }))

    return { pairs, callsScanned: rows.length }
}
