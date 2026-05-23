/**
 * PR-Р: переводит технические сообщения AI-стажёра на понятный язык.
 *
 * Бэкенд возвращает причины вроде "confidence=0 < threshold=0.7",
 * "mode=operator_locked", "channel=whatsapp not in activeChannels" —
 * это диагностические строки, не для оператора. Тут маппим их на
 * человекочитаемые сообщения, которые понятны без программистского
 * жаргона.
 *
 * Используется в AiProposedReplyBubble.tsx для proposal.reasoning
 * и silentMessage. Если pattern не распознан — возвращает исходную
 * строку (для случаев, когда reasoning от LLM уже в человеческой форме).
 */

export function humanizeAiReason(raw: string | null | undefined): string {
    if (!raw) return 'AI пока ничего не предлагает'
    const t = String(raw).trim()
    if (!t) return 'AI пока ничего не предлагает'

    // confidence=N < threshold=M — AI не уверен в классификации
    const conf = t.match(/confidence=([\d.]+)\s*<\s*threshold=([\d.]+)/i)
    if (conf) {
        const c = Math.round(parseFloat(conf[1]) * 100)
        return c === 0
            ? 'AI не смог разобрать сообщение клиента — нужен оператор'
            : `AI не уверен в ответе (${c}%). Чтобы не ошибиться, лучше ответит менеджер`
    }

    // mode=operator_locked — режим «только оператор»
    if (/mode=operator_locked/i.test(t)) {
        return 'AI выключен в настройках — отвечает только оператор'
    }

    // channel=X not in activeChannels — канал не в whitelist
    const chMatch = t.match(/channel=(\w+)\s+not in activeChannels/i)
    if (chMatch) {
        const labels: Record<string, string> = {
            whatsapp: 'WhatsApp',
            telegram: 'Telegram',
            max: 'MAX',
            phone: 'телефонии',
            avito: 'Avito',
        }
        return `AI не подключён к ${labels[chMatch[1]] ?? chMatch[1]}`
    }

    // maxAutoRepliesPerChat=N reached today — лимит ответов в сутки
    const cap = t.match(/maxAutoRepliesPerChat=(\d+)\s+reached today/i)
    if (cap) {
        return `AI уже ответил ${cap[1]} ${pluralReplies(parseInt(cap[1], 10))} сегодня — дальше отвечает оператор`
    }

    // suggest_only mode — это нормально, AI просто предлагает
    if (/suggest_only/i.test(t)) {
        return 'AI готовит черновик — менеджер сам решит, отправлять ли'
    }

    // Ошибка ответа от LLM
    if (/^Ошибка:/i.test(t) || /api error|timeout|rate limit/i.test(t)) {
        return 'AI временно недоступен — попробуйте чуть позже'
    }

    // Нет inbound сообщений (PR9.53)
    if (/no inbound|только outbound|собеседник пока ничего/i.test(t)) {
        return 'Собеседник пока ничего не написал — AI отвечать не на что'
    }

    // Ядро пустое
    if (/no knowledge|knowledge.*empty|ядро.*пуст/i.test(t)) {
        return 'Ядро знаний пока пустое — нечего использовать для ответа'
    }

    // Если строка похожа на диагностику (X=Y, <, >, code-like) — generic message
    if (/[=<>]/.test(t) && t.length < 80) {
        return 'Не хватает данных в Ядре знаний, чтобы ответить уверенно'
    }

    // Уже человекочитаемая строка (например reasoning от LLM) — оставляем как есть
    return t
}

function pluralReplies(n: number): string {
    const n10 = n % 10
    const n100 = n % 100
    if (n10 === 1 && n100 !== 11) return 'раз'
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return 'раза'
    return 'раз'
}
