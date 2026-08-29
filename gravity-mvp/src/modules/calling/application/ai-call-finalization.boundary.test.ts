import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8')

describe('AI-call finalization ownership and side-effect boundary', () => {
    const route = read('src/app/api/ai-calls/sessions/[id]/finalize/route.ts')
    const operation = read('src/modules/calling/application/ai-call-finalization.ts')
    const runtime = read('src/modules/calling/application/ai-call-finalization-runtime.ts')
    const persistence = read('src/modules/calling/internal/ai-calls/ai-call-finalization-prisma-adapter.ts')

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
})
