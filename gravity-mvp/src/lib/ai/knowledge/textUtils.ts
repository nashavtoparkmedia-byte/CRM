/**
 * AI Knowledge Core — text utilities.
 *
 * Чистый набор pure-функций без побочных эффектов. Используется
 * extractor'ом (PR2) для PII-маскировки исходных фрагментов перед
 * сохранением, дедупликации по trigram-Jaccard, и conflict-detector'ом
 * для сравнения числовых значений в семантически близких фактах.
 *
 * Embeddings не используются (см. memory/project_ai_knowledge_core.md
 * red lines). Всё детерминированно.
 */

// ─── Normalization ────────────────────────────────────────────────

/**
 * Приводит текст к каноничной форме для сравнения:
 * lowercase, удалены знаки препинания, схлопнуты пробелы. Кириллицу
 * сохраняем (\p{L} + \p{N}), всё остальное считаем разделителем.
 *
 * Используется для построения trigram-set'ов и для матчинга. НЕ
 * использовать для отображения — это lossy преобразование.
 */
export function normalize(text: string): string {
    if (!text) return ''
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

// ─── Trigrams + Jaccard ───────────────────────────────────────────

/**
 * Trigram-set из нормализованного текста. Скользящее окно длиной 3.
 *
 * Для строк короче 3 символов возвращает Set со всей строкой как
 * единственным элементом — иначе Jaccard будет всегда 0 на коротких
 * заголовках типа "ИП", и dedup сломается.
 */
export function trigrams(text: string): Set<string> {
    const s = normalize(text)
    if (s.length === 0) return new Set()
    if (s.length < 3) return new Set([s])
    const out = new Set<string>()
    for (let i = 0; i <= s.length - 3; i++) {
        out.add(s.slice(i, i + 3))
    }
    return out
}

/**
 * Jaccard-similarity двух set'ов: |A ∩ B| / |A ∪ B|. Возвращает 0..1.
 * Если оба пустые — возвращает 0 (не 1), чтобы не считать
 * "оба пустые" эквивалентом.
 */
export function jaccard<T>(a: Set<T>, b: Set<T>): number {
    if (a.size === 0 || b.size === 0) return 0
    let intersect = 0
    for (const x of a) if (b.has(x)) intersect++
    const union = a.size + b.size - intersect
    return union === 0 ? 0 : intersect / union
}

/** Высокоуровневая обёртка: Jaccard над trigrams двух raw-строк. */
export function similarity(a: string, b: string): number {
    return jaccard(trigrams(a), trigrams(b))
}

// ─── PII masking ──────────────────────────────────────────────────

/**
 * Маскирует обнаруживаемые PII в свободном тексте ДО сохранения в
 * AiKnowledgeSource.excerpt. Регексы намеренно консервативные — лучше
 * не замаскировать сомнительное, чем разрушить читаемость excerpt'а.
 *
 * Поддерживаемые форматы:
 *   - Российские телефоны: +7/8 + любой формат скобок/дефисов
 *   - Email
 *   - Ссылки http(s)://...
 *   - ВУ-номера РФ (формат 2 + разделитель + 2 + разделитель + 6 цифр —
 *     разделитель обязателен; слитные 10-значные ID → [номер])
 *   - Длинные числовые ID (10+ цифр подряд)
 *
 * НЕ маскирует:
 *   - Имена (нужен NER, пока TODO)
 *   - Адреса (нужен ML, пока TODO)
 *   - Короткие числа (3-9 цифр) — это могут быть тарифы/комиссии.
 */
export function maskPII(text: string): string {
    if (!text) return ''
    let out = text
    // Email — раньше телефонов, чтобы local-part с цифрами не попал в phone-regex.
    out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    // URL (http/https/ftp).
    out = out.replace(/\b(?:https?|ftp):\/\/\S+/gi, '[ссылка]')
    // ВУ-номер РФ: 2 + разделитель + 2 + разделитель + 6 цифр.
    // Разделитель ОБЯЗАТЕЛЕН — слитные 10-значные числа уходят в [номер].
    out = out.replace(/\b\d{2}[\s-]\d{2}[\s-]\d{6}\b/g, '[ву]')
    // Российский телефон: +7 или 8, любые скобки/дефисы/пробелы.
    out = out.replace(
        /(?:\+7|8)[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/g,
        '[телефон]'
    )
    // Длинный numeric id (10+ цифр подряд) — паспорта, СНИЛС, карты.
    out = out.replace(/\b\d{10,}\b/g, '[номер]')
    // Схлопнуть повторные [телефон][телефон] → [телефон].
    out = out.replace(/(\[(?:телефон|email|ссылка|ву|номер)\])\1+/g, '$1')
    return out
}

// ─── Numeric value extraction (для conflict detector) ─────────────

export interface NumericValue {
    /** Нормализованное число (4.5, не "4,5"). */
    value: number
    /** Нормализованный юнит: %, ₽, тыс, сут, дн, год, лет, месяц, раз, км, шт. */
    unit: string
    /** Исходная подстрока (для отладки). */
    raw: string
}

/**
 * Вытаскивает числовые величины с единицами измерения. Используется
 * conflict detector'ом: два item'а в одной секции с одинаковыми
 * unit'ами но разными value — конфликт.
 *
 *   "3.99%" → { value: 3.99, unit: "%" }
 *   "8 ₽"   → { value: 8,    unit: "₽" }
 *   "14 дн" → { value: 14,   unit: "дн" }
 */
export function extractNumericValues(text: string): NumericValue[] {
    if (!text) return []
    const out: NumericValue[] = []
    const re = /(\d+(?:[.,]\d+)?)\s*(%|₽|руб(?:\.|\b)|тыс(?:\.|\b)|сут(?:ок|ки|\.|\b)|дн(?:ей|я|\.|\b)|год(?:а|ов|\.|\b)|лет\b|месяц(?:а|ев|\.|\b)|раз\b|км(?:\/ч)?|шт(?:\.|\b))/giu
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
        const raw = m[0]
        const numStr = m[1].replace(',', '.')
        const value = parseFloat(numStr)
        if (!Number.isFinite(value)) continue
        const unit = normalizeUnit(m[2])
        out.push({ value, unit, raw })
    }
    return out
}

function normalizeUnit(u: string): string {
    const s = u.toLowerCase().replace(/\.$/, '')
    if (s === 'руб') return '₽'
    if (s.startsWith('сут')) return 'сут'
    if (s.startsWith('дн')) return 'дн'
    if (s.startsWith('год') || s === 'лет') return 'год'
    if (s.startsWith('месяц')) return 'месяц'
    if (s === 'км/ч') return 'кмч'
    if (s === 'тыс') return 'тыс'
    if (s === 'шт') return 'шт'
    return s
}

// ─── Verbatim evidence check ──────────────────────────────────────

/**
 * Проверяет, что extractor НЕ выдумал evidence_excerpt: фрагмент должен
 * быть verbatim-подстрокой одного из исходных сообщений пары. Это
 * первая линия защиты от галлюцинаций экстрактора.
 *
 * Возвращает true, если excerpt действительно встречается в одном из
 * sourceTexts. Сравнение case-insensitive, пробелы collapsed.
 */
export function isVerbatimEvidence(excerpt: string, sourceTexts: string[]): boolean {
    if (!excerpt || sourceTexts.length === 0) return false
    const needle = collapseWs(excerpt).toLowerCase()
    if (needle.length < 5) return false // слишком короткое — может случайно совпасть
    for (const src of sourceTexts) {
        const hay = collapseWs(src).toLowerCase()
        if (hay.includes(needle)) return true
    }
    return false
}

function collapseWs(s: string): string {
    return s.replace(/\s+/g, ' ').trim()
}

// ─── excerptHash (для AiKnowledgeSource @@unique([itemId, excerptHash])) ─

import { createHash } from 'crypto'

/**
 * Стабильный хэш для идемпотентности повторной экстракции.
 * Включает messageId (если есть), чтобы один и тот же фрагмент,
 * найденный в разных сообщениях, дал РАЗНЫЕ хэши.
 */
export function makeExcerptHash(messageId: string | null, excerpt: string): string {
    const h = createHash('sha256')
    h.update(messageId ?? '')
    h.update('\x00')
    h.update(normalize(excerpt))
    return h.digest('hex')
}
