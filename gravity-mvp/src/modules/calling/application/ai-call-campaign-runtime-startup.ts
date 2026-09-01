import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import { aiCallCampaignPrismaPort } from '../internal/ai-calls/ai-call-campaign-prisma-adapter'
import { aiCallCampaignSimulatedDialPort } from '../internal/ai-calls/ai-call-campaign-simulated-dial-adapter'
import { createAiCallCampaignWorkerRuntime } from './ai-call-campaign-runtime'
import { readAiCallCampaignRuntimeMode } from './ai-call-campaign-runtime-mode'

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
    if (value == null || value === '') return fallback
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

export async function runAiCallCampaignRuntimeCycleV1() {
    const mode = readAiCallCampaignRuntimeMode()
    if (mode !== 'simulated') return { mode, kind: 'not_run' as const }
    await aiCallCampaignPrismaPort.configureGlobalAdmission({
        concurrentLimit: boundedInteger(process.env.AI_CALL_CAMPAIGN_GLOBAL_CONCURRENCY, 4, 1, 1_000),
        ratePerMinute: boundedInteger(process.env.AI_CALL_CAMPAIGN_GLOBAL_RATE_PER_MINUTE, 60, 1, 10_000),
    })
    const worker = createAiCallCampaignWorkerRuntime({
        dial: aiCallCampaignSimulatedDialPort,
        workerId: `crm-simulated-campaign-worker:${process.pid}`,
        claimLeaseMs: boundedInteger(process.env.AI_CALL_CAMPAIGN_CLAIM_LEASE_MS, 30_000, 250, 300_000),
        admissionLeaseMs: boundedInteger(process.env.AI_CALL_CAMPAIGN_ADMISSION_LEASE_MS, 60_000, 250, 300_000),
    })
    return { mode, ...(await worker()) }
}

export function startAiCallCampaignRuntimeV1(
    runJob: (name: string, operation: () => Promise<unknown>) => Promise<unknown>,
): NodeJS.Timeout | null {
    const mode = readAiCallCampaignRuntimeMode()
    if (mode === 'disabled') {
        opsLog('info', 'ai_call_campaign_runtime_disabled', { operation: 'startup' })
        return null
    }
    if (mode === 'unsupported_live' || mode === 'simulated_unavailable') {
        opsLog('error', 'ai_call_campaign_runtime_mode_rejected', {
            operation: 'startup',
            configuredMode: process.env.AI_CALL_CAMPAIGN_RUNTIME_MODE,
            reason: mode,
        })
        return null
    }
    const intervalMs = boundedInteger(process.env.AI_CALL_CAMPAIGN_INTERVAL_MS, 1_000, 250, 60_000)
    const run = () => runJob('ai_call_campaign_runtime', runAiCallCampaignRuntimeCycleV1)
    void run()
    const interval = setInterval(run, intervalMs)
    opsLog('info', 'ai_call_campaign_runtime_started', { operation: 'startup', mode, intervalMs })
    return interval
}
