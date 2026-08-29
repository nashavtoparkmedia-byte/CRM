/**
 * In-process AI-call simulator.
 *
 * Runs the same prompt + tool surface the AudioBridge uses on a real call,
 * but driven by a scripted array of lead replies instead of live STT. No
 * FreeSWITCH, no audio, no MinIO — just GPT round-trips. Lets product /
 * QA iterate on scenario wording and tool definitions without burning
 * minutes on real SIP traffic.
 *
 * Mirrors:
 *   tools/audio-bridge-day1/llm-client.js   — TOOLS + buildSystemMessage
 *   tools/audio-bridge-day1/call-session.js — turn loop, tool dispatch,
 *                                             qualification result shape
 *
 * Kept side-by-side rather than DRY'd into a shared module because:
 *   1. The bridge is a separate Node process with its own bundle/deps.
 *   2. The two surfaces are intentionally evolved together but live in
 *      different runtimes (Node vs Next.js); a small drift is acceptable.
 *      The CLAUDE.md launch trigger spells out that both must move when
 *      we change tool definitions.
 *
 * Not exported from any HTTP route by itself — see
 * src/app/api/ai-calls/dev-simulate/route.ts for the public surface.
 */

import type OpenAI from 'openai'
import { createCallingOpenAiChatCompletionV1 } from '@/modules/calling/public/v1/openai-chat-completion'
import type { AiCallScenarioWithProject } from '@/lib/ai-call/scenarios'

// ── Tool surface (must mirror bridge llm-client.js TOOLS exactly) ──────────────

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
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
                            'Если поле не входит в этот список — используй snake_case ярлык.',
                    },
                    value: { type: 'string', description: 'Значение, нормализованное в короткую фразу.' },
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
                    },
                    lead_summary: { type: 'string' },
                    reason: { type: 'string' },
                    manager_task: {
                        type: 'object',
                        properties: {
                            should_create: { type: 'boolean' },
                            summary: { type: 'string' },
                            priority: { type: 'string', enum: ['high', 'normal', 'low'] },
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
                properties: { reason: { type: 'string' } },
                required: ['reason'],
            },
        },
    },
]

// ── System prompt (mirrors bridge llm-client.js buildSystemMessage) ────────────

function buildSystemMessage(scenario: AiCallScenarioWithProject): string {
    const questions = (scenario.questions ?? [])
        .map((q, i) => `${i + 1}. ${q.text}`)
        .join('\n')

    return [
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
    ].join('\n')
}

// ── Public types ───────────────────────────────────────────────────────────────

export interface SimulatedTurn {
    role: 'assistant' | 'user' | 'system' | 'tool'
    content: string
    tool?: { name: string; args: Record<string, unknown> }
}

export interface SimulationResult {
    transcript: SimulatedTurn[]
    leadData: Record<string, string>
    finalResult: {
        qualification_status?: string
        lead_summary?: string
        reason?: string
        manager_task?: unknown
        transfer_reason?: string
        lead_data?: Record<string, string>
    } | null
    /** 'completed' if end_call fired, 'transferred' if transfer_to_manager, 'closed' if leadMessages exhausted without end. */
    terminationReason: 'completed' | 'transferred' | 'closed'
    /** Raw OpenAI calls made — useful for cost auditing in the dev UI. */
    llmCallsCount: number
}

export interface SimulateOptions {
    scenario: AiCallScenarioWithProject
    /** Lead's replies, fed in sequence. The bot greets first; each subsequent
     *  assistant turn consumes one item. If the bot keeps tool-calling
     *  (e.g. save_lead_data then more) those don't consume a lead message —
     *  the tool reply loops back to the same turn. */
    leadMessages: string[]
    /** Override model (default gpt-4o-mini, same as live calls). */
    model?: string
    /** Safety limit on total LLM round-trips. Prevents an off-rails model
     *  from looping save_lead_data forever. Default 20. */
    maxTurns?: number
}

// ── Simulator ──────────────────────────────────────────────────────────────────

/**
 * Run a full scripted dialog through GPT. The structure mirrors call-session.js
 * but is purely sequential: no debouncing, no audio, no real-time concerns.
 */
export async function simulateAiCall(opts: SimulateOptions): Promise<SimulationResult> {
    const { scenario, leadMessages } = opts
    const model = opts.model ?? process.env.AI_CALL_LLM_MODEL ?? 'gpt-4o-mini'
    const maxTurns = opts.maxTurns ?? 20

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: 'system', content: buildSystemMessage(scenario) },
        // Synthetic kick-off — same trick the bridge uses to make the model
        // emit the opening line before any user turn exists.
        { role: 'user', content: '(начни разговор: поздоровайся и задай первый вопрос из сценария)' },
    ]

    const transcript: SimulatedTurn[] = []
    const leadData: Record<string, string> = {}
    let finalResult: SimulationResult['finalResult'] = null
    let terminationReason: SimulationResult['terminationReason'] = 'closed'
    let llmCallsCount = 0

    let leadIdx = 0
    let turn = 0

    // The loop: ask GPT, dispatch text (consume next leadMessage) or tool.
    while (turn < maxTurns) {
        turn++
        llmCallsCount++

        const completion = await createCallingOpenAiChatCompletionV1({
            model,
            messages,
            tools: TOOLS,
            temperature: 0.4,
        })

        const choice = completion.choices[0]
        if (!choice) break

        const msg = choice.message
        const toolCall = msg.tool_calls?.[0]

        if (toolCall && toolCall.function) {
            let parsedArgs: Record<string, unknown> = {}
            try { parsedArgs = JSON.parse(toolCall.function.arguments || '{}') } catch { /* keep empty */ }
            const toolName = toolCall.function.name

            // Record the tool call into history so the model sees it next round.
            messages.push({
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: toolCall.id,
                    type: 'function',
                    function: { name: toolName, arguments: toolCall.function.arguments ?? '{}' },
                }],
            })
            transcript.push({ role: 'tool', content: `${toolName}(${JSON.stringify(parsedArgs)})`, tool: { name: toolName, args: parsedArgs } })

            if (toolName === 'save_lead_data') {
                const field = String(parsedArgs.field ?? '')
                const value = String(parsedArgs.value ?? '')
                if (field) leadData[field] = value
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: JSON.stringify({ ok: true }),
                })
                // Loop back to the same turn — model decides what to say next.
                continue
            }

            if (toolName === 'transfer_to_manager') {
                finalResult = {
                    qualification_status: 'unclear',
                    lead_summary: 'Лид запросил живого менеджера.',
                    reason: String(parsedArgs.reason ?? ''),
                    transfer_reason: String(parsedArgs.reason ?? ''),
                    manager_task: {
                        should_create: true,
                        summary: `Перезвонить лиду — запросил живого менеджера: ${parsedArgs.reason ?? ''}`,
                        priority: 'high',
                    },
                    lead_data: leadData,
                }
                terminationReason = 'transferred'
                // Bot's final line — mirrors call-session._dispatchTool.
                transcript.push({ role: 'assistant', content: 'Соединяю вас с менеджером, оставайтесь на линии.' })
                break
            }

            if (toolName === 'end_call') {
                finalResult = {
                    qualification_status: String(parsedArgs.qualification_status ?? 'unclear'),
                    lead_summary: String(parsedArgs.lead_summary ?? ''),
                    reason: String(parsedArgs.reason ?? ''),
                    manager_task: parsedArgs.manager_task ?? { should_create: false },
                    lead_data: leadData,
                }
                terminationReason = 'completed'
                transcript.push({ role: 'assistant', content: 'Спасибо за разговор, всего доброго.' })
                break
            }

            // Unknown tool — fed back as error, model decides next move.
            messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ error: 'unknown_tool' }),
            })
            continue
        }

        // Plain text turn — model said something. Record it, then feed next
        // scripted lead message (if any).
        const text = (msg.content ?? '').trim()
        if (text) {
            messages.push({ role: 'assistant', content: text })
            transcript.push({ role: 'assistant', content: text })
        }

        if (leadIdx >= leadMessages.length) {
            // Ran out of scripted lead replies. Treat as natural end —
            // simulation closes without an explicit end_call tool. Mirrors
            // the bridge path where the lead hangs up early.
            break
        }
        const userText = leadMessages[leadIdx++]
        messages.push({ role: 'user', content: userText })
        transcript.push({ role: 'user', content: userText })
    }

    return { transcript, leadData, finalResult, terminationReason, llmCallsCount }
}
