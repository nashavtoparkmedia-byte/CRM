/* eslint-disable @typescript-eslint/no-explicit-any -- dev-only endpoint,
   plain JSON body validation rather than a full Zod schema for now. */
import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/users/user-service'
import { getScenario, DEFAULT_PROJECT_ID, listScenarios } from '@/lib/ai-call/scenarios'
import { simulateAiCall } from '@/lib/ai-call/devSimulator'
import { opsLog } from '@/lib/opsLog'

export const dynamic = 'force-dynamic'

/**
 * POST /api/ai-calls/dev-simulate
 *
 * Run a full AI-call dialog in-process — no FreeSWITCH, no audio, no
 * MinIO. Lets product / QA iterate on scenario prompts and on the
 * end_call / save_lead_data tool surface without burning real minutes.
 *
 *  body: {
 *    scenarioId?: string     // explicit, otherwise default project's first active
 *    leadMessages: string[]  // scripted lead replies in sequence
 *    model?: string          // e.g. 'gpt-4o-mini' (default) or 'gpt-4o'
 *    maxTurns?: number       // safety cap on LLM round-trips, default 20
 *  }
 *
 *  200: {
 *    scenarioId, scenarioName,
 *    transcript:   Array<{ role, content, tool? }>
 *    leadData:     Record<string,string>
 *    finalResult:  QualificationResult | null
 *    terminationReason: 'completed' | 'transferred' | 'closed'
 *    llmCallsCount: number
 *  }
 *
 * Access control: any authenticated CRM user. The endpoint costs an
 * OpenAI request per turn — same surface as the live call would have
 * used, so abuse is bounded by existing OpenAI key spending. We hide it
 * behind `process.env.AI_CALL_DEV_SIMULATE_ENABLED !== 'false'` so a
 * prod deploy can switch it off cleanly via env.
 */
export async function POST(req: NextRequest) {
    if (process.env.AI_CALL_DEV_SIMULATE_ENABLED === 'false') {
        return NextResponse.json(
            { error: 'disabled', hint: 'AI_CALL_DEV_SIMULATE_ENABLED=false in env' },
            { status: 403 },
        )
    }

    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    let body: any
    try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }

    const scenarioId: string | null = body.scenarioId ?? null
    const leadMessages: unknown = body.leadMessages
    const model: string | undefined = typeof body.model === 'string' ? body.model : undefined
    const maxTurns: number | undefined = typeof body.maxTurns === 'number' ? body.maxTurns : undefined

    if (!Array.isArray(leadMessages) || leadMessages.some(m => typeof m !== 'string')) {
        return NextResponse.json(
            { error: 'leadMessages_must_be_string_array' },
            { status: 400 },
        )
    }

    // Resolve scenario the same way /api/ai-calls/start does.
    let scenario = scenarioId ? await getScenario(scenarioId) : null
    if (!scenario) {
        const list = await listScenarios({ projectId: DEFAULT_PROJECT_ID })
        scenario = list[0] ?? null
    }
    if (!scenario) {
        return NextResponse.json({ error: 'no_active_scenario' }, { status: 400 })
    }

    const startedAt = Date.now()
    try {
        const result = await simulateAiCall({
            scenario,
            leadMessages: leadMessages as string[],
            model,
            maxTurns,
        })
        const latencyMs = Date.now() - startedAt

        opsLog('info', 'ai_call_dev_simulated', {
            operation: 'ai_call',
            scenarioId: scenario.id,
            scenarioName: scenario.name,
            leadMessagesCount: leadMessages.length,
            llmCallsCount: result.llmCallsCount,
            terminationReason: result.terminationReason,
            qualification: result.finalResult?.qualification_status,
            latencyMs,
        })

        return NextResponse.json({
            scenarioId: scenario.id,
            scenarioName: scenario.name,
            transcript: result.transcript,
            leadData: result.leadData,
            finalResult: result.finalResult,
            terminationReason: result.terminationReason,
            llmCallsCount: result.llmCallsCount,
            latencyMs,
        })
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        opsLog('error', 'ai_call_dev_simulate_failed', {
            operation: 'ai_call',
            scenarioId: scenario.id,
            error: msg,
        })
        return NextResponse.json({ error: 'simulation_failed', message: msg }, { status: 500 })
    }
}
