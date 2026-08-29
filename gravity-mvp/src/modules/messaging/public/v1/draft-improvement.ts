import { callProviderTextV1 as callForText } from '@/infrastructure/providers/multi-provider-llm'

export type MessageDraftImprovePresetV1 = 'improve' | 'expand'

interface ImproveMessageDraftOptionsV1 {
    provider: string
    model: string
    apiKey: string
    draft: string
    preset: MessageDraftImprovePresetV1
    recentMessages?: Array<{ direction: 'inbound' | 'outbound'; content: string }>
    styleGuide?: string | null
}

const SYSTEM_BASE = `Ты — помощник менеджера парка такси «Наш Автопарк».
Менеджер пишет водителю/клиенту в чате и просит улучшить свой черновик
перед отправкой. Твоя задача — выдать ОДИН улучшенный вариант.

ЖЁСТКИЕ ПРАВИЛА:
1. Не меняй СМЫСЛ — только грамматику, тон, формулировки.
2. Не выдумывай новые факты, цифры, тарифы. Используй только то что
   менеджер уже написал в черновике.
3. Сохраняй язык менеджера (русский) и его стиль обращения (если был
   на «ты» — оставь на «ты», если на «вы» — на «вы»).
4. НЕ добавляй приветствие «Здравствуйте» если его не было в черновике —
   возможно это уже не первое сообщение в чате.
5. НЕ добавляй подпись/имя менеджера в конце.
6. Не оборачивай ответ в кавычки, не пиши пояснений — только текст
   улучшенного черновика. Без markdown.`

const PRESET_INSTRUCTIONS: Record<MessageDraftImprovePresetV1, string> = {
    improve: `РЕЖИМ: «Просто улучшить»
— Исправь опечатки и грамматические ошибки
— Сделай формулировки более вежливыми и профессиональными
— Объём примерно как у черновика (±20%)`,
    expand: `РЕЖИМ: «Подробнее»
— Расширь черновик: добавь больше деталей и пояснений к тому ЧТО менеджер написал
— Сохраняй те же факты — не выдумывай новые цифры/условия
— Объём в 1.5–2 раза больше черновика`,
}

export async function improveMessageDraftV1(options: ImproveMessageDraftOptionsV1): Promise<string> {
    const draft = options.draft.trim()
    if (!draft) throw new Error('Черновик пустой')

    const systemPrompt = [
        SYSTEM_BASE,
        '',
        PRESET_INSTRUCTIONS[options.preset],
        options.styleGuide ? `\nСТИЛЬ ОБЩЕНИЯ ПАРКА:\n${options.styleGuide}` : '',
    ].filter(Boolean).join('\n')

    const contextText = (options.recentMessages ?? [])
        .slice(-6)
        .map(message => `[${message.direction === 'inbound' ? 'клиент' : 'менеджер'}]: ${message.content.slice(0, 200)}`)
        .join('\n')

    const userMessage = [
        contextText ? `Контекст последних сообщений в чате:\n${contextText}\n` : '',
        `Черновик менеджера:\n${draft}`,
        '',
        'Выдай улучшенный текст (только сам текст, без префиксов и пояснений):',
    ].filter(Boolean).join('\n')

    const text = await callForText({
        provider: options.provider,
        model: options.model,
        apiKey: options.apiKey,
        systemPrompt,
        userMessage,
        maxTokens: 600,
        temperature: 0.4,
    })

    return text.trim().replace(/^["«]|["»]$/g, '').trim()
}
