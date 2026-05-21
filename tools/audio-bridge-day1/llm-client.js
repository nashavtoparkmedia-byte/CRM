/**
 * OpenAI Chat API client for AI-call dialog.
 *
 * Stateless wrapper around POST https://api.openai.com/v1/chat/completions
 * with function-calling. The CallSession owns the message history; this
 * module just sends one turn and returns either:
 *
 *   { kind: 'text', content: '...' }              — say this back to the lead
 *   { kind: 'function', name: '...', args: {...}} — execute a tool
 *
 * Tool surface (MVP):
 *   - save_lead_data        — store partial qualification answers
 *   - end_call              — wrap up: produce final summary + qualification
 *   - transfer_to_manager   — escalate (live transfer not wired in Day 1; we
 *                             just record the intent and let CRM act on it)
 *
 * Without OPENAI_API_KEY the module is disabled — see `enabled` getter.
 * Bridge logs `[llm] DISABLED` once on boot and routes around it.
 */

const runtime = require('./runtime-config')
const { withProxy } = require('./proxy-fetch')
const { buildConversationPrompt } = require('./prompt-fragments')

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 15000)

/**
 * Function definitions for OpenAI tools-API. Kept small on purpose — every
 * tool here gets exposed to the model on EVERY turn, so unused tools are
 * pure cost.
 */
const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'save_lead_data',
            description:
                'Сохранить частичные ответы лида на квалификационные вопросы. ' +
                'Вызывай каждый раз, когда лид ответил на один из вопросов сценария. ' +
                'Не обязательно дожидаться конца разговора.',
            parameters: {
                type: 'object',
                properties: {
                    field: {
                        type: 'string',
                        description:
                            'Короткое имя поля: license / experience / city / schedule / readyAt / car / objection. ' +
                            'Если поле не входит в этот список — используй snake_case ярлык, отражающий смысл.',
                    },
                    value: {
                        type: 'string',
                        description: 'Значение, услышанное от лида, нормализованное в короткую фразу.',
                    },
                },
                required: ['field', 'value'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'end_call',
            description:
                'Завершить разговор и вернуть итог квалификации. Вызывай, когда все ' +
                'основные вопросы закрыты ИЛИ когда лид однозначно отказывается продолжать.',
            parameters: {
                type: 'object',
                properties: {
                    qualification_status: {
                        type: 'string',
                        enum: ['qualified', 'not_qualified', 'unclear'],
                        description:
                            'qualified — подходит, готов работать. not_qualified — не подходит / категорично отказался. ' +
                            'unclear — данных недостаточно, нужен ручной звонок менеджера.',
                    },
                    lead_summary: {
                        type: 'string',
                        description: 'Одно-два предложения о лиде на русском.',
                    },
                    reason: {
                        type: 'string',
                        description: 'Короткое объяснение, почему такой итог.',
                    },
                    // PR #57: numeric quality score for analytics + funnel.
                    // Optional: not_qualified leads can skip it. For
                    // qualified/unclear, 0 = низкое качество, 100 = высокое.
                    // Учитывай комплексность ответов, готовность,
                    // чистоту намерения.
                    qualification_score: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 100,
                        description:
                            'Числовая оценка качества лида 0-100 (низкое → высокое). ' +
                            'Заполняй для qualified и unclear. Для not_qualified можно не заполнять.',
                    },
                    manager_task: {
                        type: 'object',
                        description:
                            'Опционально: задача для менеджера. Не задавай при ' +
                            'not_qualified — для отказников задача не нужна.',
                        properties: {
                            should_create: { type: 'boolean' },
                            summary: { type: 'string' },
                            priority: {
                                type: 'string',
                                enum: ['high', 'normal', 'low'],
                            },
                        },
                    },
                },
                required: ['qualification_status', 'lead_summary', 'reason'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'transfer_to_manager',
            description:
                'Перевести разговор на живого менеджера. Используй, когда лид настойчиво ' +
                'просит человека, или вопрос лида выходит за рамки сценария.',
            parameters: {
                type: 'object',
                properties: {
                    reason: {
                        type: 'string',
                        description: 'Зачем переводим (для лога менеджера).',
                    },
                },
                required: ['reason'],
            },
        },
    },
]

/**
 * Build the OpenAI tools array for one scenario (PR #57). When the
 * scenario carries an `outcomeSchema` (canonical field declarations),
 * override `save_lead_data.field` to an enum of those canonical keys
 * so the model is forced to use them at the point of tool-call. The
 * CRM-side validator is the safety net; this is the primary
 * enforcement.
 *
 * Scenarios without outcomeSchema get the legacy free-form tools —
 * full back-compat with existing scenarios.
 *
 * Pure function. Caller (CallSession) builds this once at session
 * start and reuses across turns.
 */
function buildTools(scenario) {
    const fields = scenario?.outcomeSchema?.fields
    if (!Array.isArray(fields) || fields.length === 0) {
        return TOOLS  // legacy passthrough — module-level array
    }
    const canonicalKeys = fields.map(f => f && f.key).filter(Boolean)
    if (canonicalKeys.length === 0) return TOOLS

    // Deep-clone TOOLS to avoid mutating the shared module-level array
    // (multiple concurrent sessions would otherwise corrupt each other).
    // JSON round-trip is fine — these are plain JSON-shaped objects.
    const tools = JSON.parse(JSON.stringify(TOOLS))
    const saveLeadData = tools.find(t => t?.function?.name === 'save_lead_data')
    if (saveLeadData) {
        const fieldHints = fields.map(f => {
            const req = f.required ? ' (обязательно)' : ''
            const type = f.type === 'enum'
                ? `enum [${(f.values ?? []).join(', ')}]`
                : f.type
            const label = f.label ? ` — ${f.label}` : ''
            return `${f.key}: ${type}${req}${label}`
        }).join('; ')
        saveLeadData.function.parameters.properties.field = {
            type: 'string',
            enum: canonicalKeys,
            description: 'Канонические поля сценария — выбирай ТОЛЬКО из этого списка: ' + fieldHints,
        }
    }
    return tools
}

/**
 * Send one turn of conversation and parse the model's response.
 *
 * @param {Object} args
 * @param {Array<{role: string, content?: string, tool_call_id?: string,
 *                tool_calls?: any[], name?: string}>} args.messages
 *   Full conversation so far (system + user + assistant + tool turns).
 * @param {string} [args.model]      Override model (default gpt-4o-mini)
 * @param {number} [args.timeoutMs]  Network timeout
 * @param {Array}  [args.tools]      Override the tool set (PR #57). When
 *                                   omitted, the module-level legacy
 *                                   TOOLS array is used.
 * @returns {Promise<{kind: 'text', content: string} |
 *                   {kind: 'function', name: string, args: object, callId: string} |
 *                   {kind: 'empty'}>}
 */
async function chatTurn({ messages, model = OPENAI_MODEL, timeoutMs = OPENAI_TIMEOUT_MS, tools }) {
    const apiKey = runtime.getOpenAiKey()
    if (!apiKey) {
        throw new Error('OpenAI API key is not configured (DB or .env) — llm-client is disabled')
    }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)

    let res
    try {
        res = await fetch('https://api.openai.com/v1/chat/completions', await withProxy({
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages,
                tools: tools ?? TOOLS,
                temperature: 0.4,
                // 4o-mini is fast enough for ~1s p50 here. We don't stream
                // because the dialog turn is short and we need the structured
                // tool_calls in one shot to dispatch the next action cleanly.
            }),
            signal: ac.signal,
        }))
    } finally {
        clearTimeout(timer)
    }

    if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 200)}`)
    }

    const data = await res.json()
    const choice = data.choices?.[0]
    if (!choice) return { kind: 'empty' }

    const msg = choice.message ?? {}
    // tool_calls (new API) takes priority over plain content — if the model
    // decided to act, we dispatch the action; the text content is usually
    // empty or a brief filler in that case.
    const toolCall = msg.tool_calls?.[0]
    if (toolCall && toolCall.function) {
        let parsedArgs = {}
        try { parsedArgs = JSON.parse(toolCall.function.arguments || '{}') } catch {}
        return {
            kind: 'function',
            name: toolCall.function.name,
            args: parsedArgs,
            callId: toolCall.id,
        }
    }

    const text = (msg.content ?? '').trim()
    if (!text) return { kind: 'empty' }
    return { kind: 'text', content: text }
}

/**
 * Legacy monolithic system-prompt builder. Used directly when a
 * scenario has no `fragments` configured (PR #63 fallback path).
 *
 * Kept as a separate function so prompt-fragments.js can call back
 * into it via dependency injection without circular-import gymnastics.
 */
function buildLegacySystemMessage(scenario) {
    const questions = (scenario.questions ?? []).map((q, i) => `${i + 1}. ${q.text}`).join('\n')
    const promptParts = [
        scenario.systemPrompt ?? '',
        '',
        'Вопросы по порядку (закрывай по одному, не задавай все сразу):',
        questions || '— (вопросов нет, действуй по системному промту)',
        '',
        'Правила речи (КРИТИЧНО — это телефонный звонок, не чат):',
        '— Каждая твоя реплика — НЕ БОЛЬШЕ 1–2 коротких предложений. Лимит ≈ 20 слов.',
        '— Каждая реплика заканчивается ОДНИМ конкретным вопросом (либо коротким завершающим «всего доброго», если звонок окончен).',
        '— После своей реплики ЖДИ ответ лида. Не задавай следующий вопрос сразу.',
        '— Не повторяй сам себя в одной реплике. Не перефразируй то же самое дважды подряд.',
        '— Не пиши вступления вроде «отлично, а теперь следующий вопрос». Сразу по делу.',
        '— Если лид молчит/STT прислал мусор/неразборчиво — переспроси один раз коротко: «Не расслышал, повторите?». Дважды не переспрашивай — лучше задай следующий вопрос.',
        '',
        'Правила сценария:',
        '— Говори по-русски, как живой менеджер парка, без формальностей.',
        '— После каждого внятного ответа лида вызывай save_lead_data.',
        '— Когда все вопросы закрыты — вызывай end_call с итогом.',
        '— Если лид агрессивен, требует человека или вопрос вне сценария — вызывай transfer_to_manager.',
        '— Не сочиняй факты. Не отвечай на off-topic — мягко возвращай к вопросу.',
    ]

    // PR #57: when the scenario declares an outcomeSchema, append a
    // canonical-key cheat sheet so the model uses the right `field`
    // names in save_lead_data. The save_lead_data tool's `field` arg
    // also gets constrained to this enum via buildTools — this prose
    // version is for the human-language reasoning layer.
    const fields = scenario.outcomeSchema?.fields
    if (Array.isArray(fields) && fields.length > 0) {
        const lines = fields.map(f => {
            const req = f.required ? ' (обязательно)' : ''
            const type = f.type === 'enum'
                ? `enum [${(f.values ?? []).join(', ')}]`
                : f.type
            const label = f.label ? ` — ${f.label}` : ''
            return `  • ${f.key}: ${type}${req}${label}`
        }).join('\n')
        promptParts.push(
            '',
            'Канонические поля для save_lead_data (используй ТОЛЬКО эти имена field):',
            lines,
        )
    }

    // PR #57: also nudge the model to emit qualification_score in
    // end_call. The tool schema already has the field — this prose
    // reinforces it for older models that under-use optional args.
    promptParts.push(
        '',
        'В end_call добавь qualification_score 0-100 (опционально для not_qualified): оценка качества лида.',
    )

    return promptParts.join('\n')
}

/**
 * Build the initial system message for a given scenario row from CRM.
 *
 * PR #63: routes through the prompt-fragments composer. If the
 * scenario opted into fragments (all 4 required slots valid), the
 * composer assembles the prompt from named pieces. Otherwise it
 * falls through to the legacy monolithic builder (byte-identical
 * behaviour for existing scenarios — no forced migration).
 */
function buildSystemMessage(scenario) {
    return buildConversationPrompt({
        scenario,
        legacyBuilder: buildLegacySystemMessage,
    })
}

// `enabled` is now a function — the answer depends on runtime config
// which can change at call time (admin saves a key via the UI). Code that
// used to check `llm.enabled` should call `llm.enabled()` instead.
function enabled() {
    return !!runtime.getOpenAiKey()
}

module.exports = {
    chatTurn,
    buildSystemMessage,
    buildTools,
    TOOLS,
    enabled,
}
