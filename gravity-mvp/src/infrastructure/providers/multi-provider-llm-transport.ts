/**
 * PR9.52 — shared-infrastructure multi-provider LLM transport.
 *
 * До этого PR `IntentClassifier` и `ResponseGenerator` жёстко ходили
 * в `api.anthropic.com`, игнорируя `config.provider`. Если у пользователя
 * стоял provider='openai' с OpenAI-ключом — pipeline молча шёл в Anthropic
 * с этим ключом и получал «invalid x-api-key».
 *
 * Этот модуль — единственная точка вызова LLM для runtime. Маршрутизация
 * по `provider`:
 *   - `anthropic` → `https://api.anthropic.com/v1/messages`
 *   - `openai`    → `https://api.openai.com/v1/chat/completions`
 *
 * Два режима вызова:
 *   - `callForText`  — для генератора ответа (свободный текст)
 *   - `callForJson`  — для классификатора (response_format=json_object
 *     на OpenAI; на Anthropic используем prefilled '{' трюк)
 *
 * Не вынес в один общий helper с Extractor.ts — Extractor имеет свою
 * слегка отличающуюся семантику (json_object, parse, etc). Лучше оставить
 * два отдельных клиента, чем накручивать опции в общем.
 */

export type LlmProvider = 'anthropic' | 'openai'

interface CallOptions {
    provider:     LlmProvider | string  // принимаем string из config
    model:        string
    apiKey:       string
    systemPrompt: string
    /** Массив сообщений (история чата) или один user message. */
    messages?:    Array<{ role: 'user' | 'assistant'; content: string }>
    userMessage?: string
    maxTokens?:   number
    temperature?: number
}

function asMessages(opts: CallOptions): Array<{ role: 'user' | 'assistant'; content: string }> {
    if (opts.messages && opts.messages.length > 0) return opts.messages
    if (opts.userMessage) return [{ role: 'user', content: opts.userMessage }]
    return []
}

/**
 * Свободно-текстовый ответ. Используется ResponseGenerator.
 * Кидает Error при non-2xx (выше catch'нется и попадёт в журнал AI).
 */
export async function callForText(opts: CallOptions): Promise<string> {
    const provider = (opts.provider === 'openai') ? 'openai' : 'anthropic'
    const messages = asMessages(opts)

    if (provider === 'openai') {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${opts.apiKey}`,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({
                model:       opts.model,
                temperature: opts.temperature ?? 0.3,
                max_tokens:  opts.maxTokens   ?? 500,
                messages: [
                    { role: 'system', content: opts.systemPrompt },
                    ...messages,
                ],
            }),
        })
        if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error(`OpenAI response error: ${err?.error?.message || res.status}`)
        }
        const data: any = await res.json()
        return (data?.choices?.[0]?.message?.content ?? '').trim()
    }

    // Anthropic
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
            'x-api-key':         opts.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type':      'application/json',
        },
        body: JSON.stringify({
            model:       opts.model,
            max_tokens:  opts.maxTokens   ?? 500,
            temperature: opts.temperature ?? 0.3,
            system:      opts.systemPrompt,
            messages,
        }),
    })
    if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(`Anthropic response error: ${err?.error?.message || res.status}`)
    }
    const data: any = await res.json()
    return (data?.content?.[0]?.text ?? '').trim()
}

/**
 * JSON-ответ. Используется IntentClassifier.
 * Возвращает «сырой» текст — caller сам парсит JSON.parse() + handle errors.
 * На OpenAI используется `response_format: 'json_object'`, на Anthropic —
 * trick с prefilled '{' (модель продолжает с JSON).
 */
export async function callForJson(opts: CallOptions): Promise<string> {
    const provider = (opts.provider === 'openai') ? 'openai' : 'anthropic'
    const messages = asMessages(opts)

    if (provider === 'openai') {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${opts.apiKey}`,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({
                model:       opts.model,
                response_format: { type: 'json_object' },
                temperature: opts.temperature ?? 0,
                max_tokens:  opts.maxTokens   ?? 500,
                messages: [
                    { role: 'system', content: opts.systemPrompt },
                    ...messages,
                ],
            }),
        })
        if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error(`OpenAI classify error: ${err?.error?.message || res.status}`)
        }
        const data: any = await res.json()
        return data?.choices?.[0]?.message?.content ?? ''
    }

    // Anthropic — prefilled '{' трюк (модель продолжает JSON)
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
            'x-api-key':         opts.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type':      'application/json',
        },
        body: JSON.stringify({
            model:       opts.model,
            max_tokens:  opts.maxTokens   ?? 500,
            temperature: opts.temperature ?? 0,
            system:      opts.systemPrompt,
            messages: [
                ...messages,
                { role: 'assistant', content: '{' },
            ],
        }),
    })
    if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(`Anthropic classify error: ${err?.error?.message || res.status}`)
    }
    const data: any = await res.json()
    const tail: string = data?.content?.[0]?.text ?? ''
    return '{' + tail
}
