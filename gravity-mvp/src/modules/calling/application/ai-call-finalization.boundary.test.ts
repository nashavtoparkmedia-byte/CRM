import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8')

describe('AI-call finalization ownership and side-effect boundary', () => {
    const route = read('src/app/api/ai-calls/sessions/[id]/finalize/route.ts')
    const operation = read('src/modules/calling/application/ai-call-finalization.ts')
    const runtime = read('src/modules/calling/application/ai-call-finalization-runtime.ts')
    const persistence = read('src/modules/calling/internal/ai-calls/ai-call-finalization-prisma-adapter.ts')
    const lifecycle = read('src/modules/calling/application/ai-call-lifecycle.ts')
    const lifecyclePersistence = read('src/modules/calling/internal/ai-calls/ai-call-lifecycle-prisma-adapter.ts')
    const transcript = read('src/modules/calling/application/ai-call-transcript.ts')
    const transcriptPersistence = read('src/modules/calling/internal/ai-calls/ai-call-transcript-prisma-adapter.ts')
    const stateRoute = read('src/app/api/ai-calls/sessions/[id]/state/route.ts')
    const transcriptRoute = read('src/app/api/ai-calls/sessions/[id]/transcript-item/route.ts')

    it('keeps the HTTP route thin and authenticates before request/resource access', () => {
        const handler = route.slice(route.indexOf('export async function POST'))
        expect(handler.indexOf('isBridgeMachineRequestAuthenticated(req.headers)')).toBeGreaterThanOrEqual(0)
        expect(handler.indexOf('isBridgeMachineRequestAuthenticated(req.headers)')).toBeLessThan(handler.indexOf('await ctx.params'))
        expect(route).toContain('finalizeAiCall(id, body)')
        expect(route).not.toMatch(/\bprisma\b|createTask|work-management/)
    })

    it('keeps Calling persistence scoped to Call and uses only the public Work Management command', () => {
        expect(persistence).toContain('tx.call.update')
        expect(persistence).not.toMatch(/(?:prisma|tx)\.task\.|TaskPersistence|legacy-prisma-idempotent-task/)
        expect(operation).not.toMatch(/(?:prisma|tx)\.task\./)
        expect(runtime).toContain("from '@/modules/work-management/public/v1'")
        expect(runtime).toContain('CREATE_IDEMPOTENT_TASK_COMMAND_V1')
        expect(runtime).not.toContain('/work-management/internal/')
    })

    it('introduces no provider, telephone, SIP, STT, or TTS execution path', () => {
        const finalizationSources = `${route}\n${operation}\n${persistence}`
        expect(finalizationSources).not.toMatch(/\bfetch\s*\(|openai\.|freeswitch|originate\s*\(|sipClient|sttClient|ttsClient/i)
    })

    it('keeps lifecycle and transcript routes thin after machine authentication', () => {
        for (const source of [stateRoute, transcriptRoute]) {
            const handler = source.slice(source.indexOf('export async function POST'))
            expect(handler.indexOf('isBridgeMachineRequestAuthenticated(req.headers)')).toBeGreaterThanOrEqual(0)
            expect(handler.indexOf('isBridgeMachineRequestAuthenticated(req.headers)'))
                .toBeLessThan(handler.indexOf('await ctx.params'))
            expect(source).not.toMatch(/from ['"]@\/lib\/prisma|\bprisma\./)
        }
    })

    it('uses Call metadata and AiCallMessage without distorting analytics events or writing Messaging', () => {
        const sources = `${lifecycle}\n${lifecyclePersistence}\n${transcript}\n${transcriptPersistence}`
        expect(lifecyclePersistence).toContain('tx.call.update')
        expect(transcriptPersistence).toContain('tx.aiCallMessage.create')
        expect(sources).not.toMatch(/(?:prisma|tx)\.(?:chat|message)\.|AiCallEvent|event-emitter/)
        expect(sources).not.toMatch(/modules\/messaging|contracts\/messaging/)
    })

    it('discovers unfinished finalization journals without a Bridge callback', () => {
        expect(persistence).toContain("'pending'")
        expect(persistence).toContain("'retry_wait'")
        expect(persistence).toContain("'in_progress'")
        expect(persistence).toContain("'terminal_failure'")
        expect(runtime).toContain('startAiCallFinalizationRecovery')
        expect(runtime).toContain('setInterval')
    })
})
