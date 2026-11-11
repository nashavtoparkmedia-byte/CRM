import { beforeEach, describe, expect, it, vi } from 'vitest'

// Values that must never reach a public health body: connection and instance ids,
// provider error text, job error text.
const CONNECTION_ID = 'conn-7f3a9c2e-wa-secret-id'
const INSTANCE_ID = 'inst-55aa77bb99cc'
const PROVIDER_ERROR = 'Protocol error (Runtime.callFunctionOn): Session closed for +79161234567'
const JOB_ERROR = 'relation "Message" does not exist at /srv/app/lib/x.ts:42'

const entries = vi.hoisted(() => ({ value: [] as Array<Record<string, unknown>> }))

vi.mock('@/modules/messaging/public/v1/transport-registry-health', () => ({
    transportRegistryHealthV1: {
        getAllEntries: () => entries.value,
        getDegradedDuration: () => 10 * 60 * 1000,
    },
}))
vi.mock('@/lib/prisma', () => ({
    prisma: {
        $queryRaw: vi.fn(async () => [{
            totalMessages: 1200, sentLast24h: 30, failedLast24h: 2, stuckCount: 1,
            totalChats: 40, statusNew: 1, statusOpen: 2, statusWaitingCustomer: 3, statusWaitingInternal: 0, statusResolved: 34,
            unassignedNeedingAttention: 2, requiresResponseCount: 3, count: 4,
        }]),
    },
}))
vi.mock('@/modules/operations-observability/public/v1/operational-job-registry', () => ({
    getOperationalJobStateV1: (name: string) => ({
        lastRunAt: new Date('2026-11-11T10:00:00.000Z'),
        lastCompletedAt: null,
        isRunning: false,
        lastError: name === 'recovery' ? JOB_ERROR : null,
        lastResult: name === 'integrity' ? { issues: [{ severity: 'warning', message: JOB_ERROR }] } : { count: 3 },
    }),
}))
vi.mock('@/lib/RetentionCleanup', () => ({
    getCumulativeCounters: () => ({ totalDeletedMessages: 5, totalDeletedEvents: 6, totalPurgedMetadata: 7, totalDeletedContacts: 8 }),
}))

function entry(channel: string, state: string) {
    return {
        connectionId: `${CONNECTION_ID}-${channel}-${state}`,
        channel,
        instanceId: INSTANCE_ID,
        state,
        lastSeen: new Date('2026-11-11T10:00:00.000Z'),
        lastError: PROVIDER_ERROR,
        retryAttempt: 2,
        readyAt: new Date('2026-11-11T09:00:00.000Z'),
        reconnectInFlight: false,
    }
}

function assertNothingSensitive(body: unknown) {
    const text = JSON.stringify(body)
    for (const value of [CONNECTION_ID, INSTANCE_ID, PROVIDER_ERROR, JOB_ERROR, '79161234567', 'Session closed', 'does not exist']) {
        expect(text).not.toContain(value)
    }
    expect(text).not.toMatch(/"(id|instanceId|lastError|connections|error|message|issues)":/)
}

describe('GET /api/health: public status only', () => {
    beforeEach(() => {
        entries.value = [entry('whatsapp', 'ready'), entry('whatsapp', 'failed'), entry('telegram', 'reconnecting')]
    })

    it('returns exactly status, the reason codes and the time', async () => {
        const { GET } = await import('./route')
        const body = await (await GET()).json()
        expect(Object.keys(body).sort()).toEqual(['degradedReasons', 'status', 'timestamp'])
        expect(body.status).toBe('error')
        expect(body.degradedReasons).toEqual(expect.arrayContaining(['transport_failed', 'transport_reconnecting', 'prolonged_transport_degradation', 'stuck_messages', 'recovery_job_crashed', 'integrity_warning']))
        for (const reason of body.degradedReasons) expect(reason).toMatch(/^[a-z_]+$/)
        assertNothingSensitive(body)
    })

    it('omits the reasons when everything is healthy', async () => {
        entries.value = [entry('whatsapp', 'ready')]
        const { prisma } = await import('@/lib/prisma')
        vi.mocked(prisma.$queryRaw).mockResolvedValue([{ stuckCount: 0, count: 0 }] as never)
        const jobs = await import('@/modules/operations-observability/public/v1/operational-job-registry')
        vi.spyOn(jobs, 'getOperationalJobStateV1').mockReturnValue(null as never)
        const { GET } = await import('./route')
        const body = await (await GET()).json()
        expect(body).toEqual({ status: 'ok', timestamp: expect.any(String) })
    })
})

describe('GET /api/transport/health: public counts only', () => {
    it('returns the status and per-channel ready/total counts, no id or error text', async () => {
        entries.value = [entry('whatsapp', 'ready'), entry('whatsapp', 'reconnecting'), entry('telegram', 'ready')]
        const { GET } = await import('../transport/health/route')
        const body = await (await GET()).json()
        expect(body).toEqual({
            status: 'degraded',
            whatsapp: { readyCount: 1, totalCount: 2 },
            telegram: { readyCount: 1, totalCount: 1 },
            timestamp: expect.any(String),
        })
        assertNothingSensitive(body)
    })

    it('reports a failed connection as error', async () => {
        entries.value = [entry('telegram', 'failed')]
        const { GET } = await import('../transport/health/route')
        expect((await (await GET()).json()).status).toBe('error')
    })

    it('a registry failure returns a code, never the error text', async () => {
        const registry = await import('@/modules/messaging/public/v1/transport-registry-health')
        vi.spyOn(registry.transportRegistryHealthV1, 'getAllEntries').mockImplementation(() => { throw new Error(PROVIDER_ERROR) })
        const { GET } = await import('../transport/health/route')
        const response = await GET()
        expect(response.status).toBe(500)
        const body = await response.json()
        expect(body).toEqual({ status: 'error', code: 'TRANSPORT_HEALTH_UNAVAILABLE' })
        assertNothingSensitive(body)
    })
})
