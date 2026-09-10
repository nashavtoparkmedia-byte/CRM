import { createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/lib/prisma'
import type { AiCallSessionStatus } from '@/lib/ai-call/types'
import {
    AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1,
    parseAiCallFinalizationFollowUpRequestedEventV1,
} from '@/contracts/calling/v1'
import { CREATE_IDEMPOTENT_TASK_COMMAND_V1 } from '@/contracts/work-management/v1'
import { createIdempotentTaskV1 } from '@/modules/work-management/public/v1'
import {
    createAiCallFinalizationOperation,
    createAiCallFinalizationRecoveryByIdentityOperation,
    readAiCallFinalizationJournal,
    type AiCallFinalizationPersistencePort,
    type IdempotentTaskCommandPort,
} from '../../application/ai-call-finalization'
import { aiCallFinalizationPrismaPort } from './ai-call-finalization-prisma-adapter'
import { prismaOutboxStoreV1 } from '@/infrastructure/outbox/prisma-outbox-store'
import { OUTBOX_STALE_CLAIM_MS_V1, publishOutboxBatchV1 } from '@/infrastructure/outbox/v1'
import { POST as changeCallState } from '@/app/api/ai-calls/sessions/[id]/state/route'
import { POST as appendTranscriptItem } from '@/app/api/ai-calls/sessions/[id]/transcript-item/route'
import { POST as finalizeCall } from '@/app/api/ai-calls/sessions/[id]/finalize/route'

const postgresProof = process.env.YOKO_AI_CALL_POSTGRES_PROOF === '1' ? describe : describe.skip
const PREFIX = 'ai-call-runtime-proof-v1'
const BRIDGE_TOKEN = 'QrStUvWxYzAbCdEfGhIjKlMnOp012345'
// Keep the test clock ahead of database CURRENT_TIMESTAMP so freshly inserted
// outbox rows are deterministically due even when this proof runs much later.
const BASE = new Date(Date.now() + 5_000)

function fingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

function callbackRequest(path: string, body: unknown): NextRequest {
    return new NextRequest(`https://crm.example${path}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-bridge-token': BRIDGE_TOKEN,
        },
        body: JSON.stringify(body),
    })
}

function finalizationBody(callId: string) {
    return {
        callUuid: `${PREFIX}:fs:${callId}`,
        reason: 'completed',
        result: {
            qualification_status: 'qualified',
            lead_summary: `Qualified ${callId}`,
            reason: 'runtime proof',
            qualification_score: 91,
            transfer_reason: null,
            manager_task: {
                should_create: true,
                summary: 'Follow up after isolated AI call',
                priority: 'high',
            },
            lead_data: { proof: true },
        },
        realUserUtterances: 1,
        events: [],
    }
}

const actualTaskPort: IdempotentTaskCommandPort = {
    async create(command) {
        const result = await createIdempotentTaskV1({
            contract: CREATE_IDEMPOTENT_TASK_COMMAND_V1,
            idempotencyKey: command.idempotencyKey,
            data: command.data,
        })
        return { task: result.task }
    },
    isPermanentError() {
        return false
    },
}

async function createCall(suffix: string, input: { transcript?: string | null; session?: AiCallSessionStatus } = {}) {
    const id = `${PREFIX}:call:${suffix}`
    return prisma.call.create({
        data: {
            id,
            direction: 'outbound',
            status: 'active',
            fromNumber: '+70000000000',
            toNumber: `+7000000${suffix.padStart(4, '0').slice(-4)}`,
            driverId: `${PREFIX}:driver`,
            fsUuid: `${PREFIX}:fs:${suffix}`,
            startedAt: new Date(BASE.getTime() - 10_000),
            isAi: true,
            aiSessionStatus: input.session ?? 'active',
            transcript: input.transcript ?? null,
            metadata: {},
        },
    })
}

async function cleanupProofRows() {
    await prisma.domainOutboxEvent.deleteMany({
        where: {
            OR: [
                { aggregateId: { startsWith: `${PREFIX}:` } },
                { eventId: { startsWith: `${PREFIX}:` } },
            ],
        },
    })
    await prisma.task.deleteMany({ where: { driverId: `${PREFIX}:driver` } })
    await prisma.call.deleteMany({ where: { id: { startsWith: `${PREFIX}:` } } })
    await prisma.driver.deleteMany({ where: { id: `${PREFIX}:driver` } })
}

function crashBeforeFollowUpPort(): AiCallFinalizationPersistencePort {
    let crash = true
    return {
        ...aiCallFinalizationPrismaPort,
        async claimFollowUp(input) {
            if (crash) {
                crash = false
                throw new Error('SIMULATED_PROCESS_CRASH_BEFORE_WORK_MANAGEMENT')
            }
            return aiCallFinalizationPrismaPort.claimFollowUp(input)
        },
    }
}

function recoveryPublisher(now: Date, persistence: AiCallFinalizationPersistencePort = aiCallFinalizationPrismaPort) {
    const recover = createAiCallFinalizationRecoveryByIdentityOperation({
        persistence,
        tasks: actualTaskPort,
        clock: () => now,
        leaseMs: 1_000,
    })
    return async (payload: unknown) => {
        const event = parseAiCallFinalizationFollowUpRequestedEventV1(payload)
        const result = await recover(event.data.callId, event.data.finalizationFingerprint)
        if (result.kind !== 'success') throw new Error(`RECOVERY_DID_NOT_CONVERGE:${result.kind}`)
    }
}

postgresProof.sequential('AI Calls Stage 5 isolated PostgreSQL runtime contract', () => {
    beforeAll(async () => {
        process.env.BRIDGE_SHARED_TOKEN = BRIDGE_TOKEN
        await cleanupProofRows()
        await prisma.driver.create({
            data: {
                id: `${PREFIX}:driver`,
                yandexDriverId: `${PREFIX}:yandex-driver`,
                fullName: 'Isolated Runtime Proof Driver',
            },
        })
    })

    afterAll(async () => {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "ai_call_runtime_atomicity_failure" ON "domain_outbox_events"')
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS "ai_call_runtime_atomicity_failure"()')
        await cleanupProofRows()
        await prisma.$disconnect()
    })

    it('rolls back terminal Call state and journal when the atomic outbox insert fails', async () => {
        const call = await createCall('atomicity')
        await prisma.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION "ai_call_runtime_atomicity_failure"()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW."aggregateId" = 'ai-call-runtime-proof-v1:call:atomicity' THEN
                    RAISE EXCEPTION 'AI_CALL_RUNTIME_ATOMICITY_FAILURE';
                END IF;
                RETURN NEW;
            END;
            $$
        `)
        await prisma.$executeRawUnsafe(`
            CREATE TRIGGER "ai_call_runtime_atomicity_failure"
            BEFORE INSERT ON "domain_outbox_events"
            FOR EACH ROW EXECUTE FUNCTION "ai_call_runtime_atomicity_failure"()
        `)

        const finalize = createAiCallFinalizationOperation({
            persistence: aiCallFinalizationPrismaPort,
            tasks: actualTaskPort,
            clock: () => BASE,
        })
        await expect(finalize(call.id, finalizationBody(call.id)))
            .rejects.toThrow('AI_CALL_RUNTIME_ATOMICITY_FAILURE')

        const stored = await prisma.call.findUniqueOrThrow({ where: { id: call.id } })
        expect(stored.aiSessionStatus).toBe('active')
        expect(stored.endedAt).toBeNull()
        expect(readAiCallFinalizationJournal(stored.metadata)).toBeNull()
        await expect(prisma.domainOutboxEvent.count({ where: { aggregateId: call.id } })).resolves.toBe(0)

        await prisma.$executeRawUnsafe('DROP TRIGGER "ai_call_runtime_atomicity_failure" ON "domain_outbox_events"')
        await prisma.$executeRawUnsafe('DROP FUNCTION "ai_call_runtime_atomicity_failure"()')
    })

    it('discovers unfinished work through the bounded indexed outbox query', async () => {
        await prisma.$executeRawUnsafe(`
            INSERT INTO "domain_outbox_events" (
                "id", "eventId", "eventType", "eventVersion", "aggregateType", "aggregateId",
                "payload", "status", "attempts", "maxAttempts", "availableAt", "publishedAt",
                "createdAt", "updatedAt"
            )
            SELECT
                $1 || sequence::text,
                $2 || sequence::text,
                $3,
                1,
                'Call',
                $4 || sequence::text,
                '{}'::jsonb,
                'published'::"DomainOutboxStatus",
                1,
                5,
                $5::timestamptz + sequence * INTERVAL '1 millisecond',
                $5::timestamptz,
                $5::timestamptz,
                $5::timestamptz
            FROM generate_series(0, 1499) AS sequence
        `,
        `${PREFIX}:noise-row:`,
        `${PREFIX}:noise-event:`,
        AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1,
        `${PREFIX}:noise-call:`,
        BASE)
        const plan = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
            EXPLAIN (FORMAT JSON)
            SELECT "id", "eventId", "eventType", "eventVersion", "payload", "attempts", "maxAttempts"
            FROM "domain_outbox_events"
            WHERE "status" IN ('pending', 'retry_wait')
              AND "availableAt" <= TIMESTAMP '2026-08-29 15:00:00'
              AND "attempts" < 5
            ORDER BY "availableAt" ASC, "createdAt" ASC
            LIMIT 25
        `)
        const indexes = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(`
            SELECT indexname FROM pg_indexes
            WHERE schemaname = current_schema() AND tablename = 'domain_outbox_events'
        `)
        expect(indexes.map((row) => row.indexname)).toContain(
            'domain_outbox_events_status_availableAt_createdAt_idx',
        )
        expect(JSON.stringify(plan)).toContain('domain_outbox_events_status_availableAt_createdAt_idx')
    })

    it('recovers a worker crash before Work Management without another Bridge callback', async () => {
        const call = await createCall('crash-before-command')
        const finalize = createAiCallFinalizationOperation({
            persistence: crashBeforeFollowUpPort(),
            tasks: actualTaskPort,
            clock: () => BASE,
            leaseMs: 1_000,
        })
        await expect(finalize(call.id, finalizationBody(call.id)))
            .rejects.toThrow('SIMULATED_PROCESS_CRASH_BEFORE_WORK_MANAGEMENT')
        await expect(prisma.task.count({ where: { driverId: `${PREFIX}:driver` } })).resolves.toBe(0)

        const result = await publishOutboxBatchV1({
            store: prismaOutboxStoreV1,
            publishers: {
                [AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1]: recoveryPublisher(
                    new Date(BASE.getTime() + 2_000),
                ),
            },
            now: new Date(BASE.getTime() + 2_000),
        })
        expect(result).toMatchObject({ claimed: 1, published: 1 })
        await expect(prisma.task.count({ where: { driverId: `${PREFIX}:driver` } })).resolves.toBe(1)
        const stored = await prisma.call.findUniqueOrThrow({ where: { id: call.id } })
        expect(readAiCallFinalizationJournal(stored.metadata)?.followUp.state).toBe('completed')
    })

    it('replays the idempotent Task after a crash before local completion', async () => {
        const call = await createCall('crash-after-command')
        const finalize = createAiCallFinalizationOperation({
            persistence: crashBeforeFollowUpPort(),
            tasks: actualTaskPort,
            clock: () => BASE,
            leaseMs: 1_000,
        })
        await expect(finalize(call.id, finalizationBody(call.id)))
            .rejects.toThrow('SIMULATED_PROCESS_CRASH_BEFORE_WORK_MANAGEMENT')

        const accepted = await prisma.call.findUniqueOrThrow({ where: { id: call.id } })
        const pending = readAiCallFinalizationJournal(accepted.metadata)
        expect(pending?.followUp.state).toBe('pending')
        const claim = await aiCallFinalizationPrismaPort.claimFollowUp({
            callId: call.id,
            fingerprint: pending!.fingerprint,
            now: BASE,
            leaseMs: 1_000,
        })
        expect(claim.kind).toBe('claimed')
        if (claim.kind !== 'claimed') throw new Error('runtime proof failed to claim follow-up')
        await actualTaskPort.create({
            idempotencyKey: claim.journal.followUp.idempotencyKey!,
            data: claim.journal.followUp.taskData!,
        })
        // Simulated hard process exit: deliberately do not call completeFollowUp.
        const taskId = `task_idem_${fingerprint(`ai-call-finalization-follow-up:v1:${call.id}`)}`
        await expect(prisma.task.count({ where: { id: taskId } })).resolves.toBe(1)

        const recoveredAt = new Date(BASE.getTime() + 2_000)
        const result = await publishOutboxBatchV1({
            store: prismaOutboxStoreV1,
            publishers: {
                [AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1]: recoveryPublisher(recoveredAt),
            },
            now: recoveredAt,
        })
        expect(result).toMatchObject({ claimed: 1, published: 1 })
        await expect(prisma.task.count({ where: { id: taskId } })).resolves.toBe(1)
        const stored = await prisma.call.findUniqueOrThrow({ where: { id: call.id } })
        expect(readAiCallFinalizationJournal(stored.metadata)?.followUp).toMatchObject({
            state: 'completed',
            task: { id: taskId },
        })
    })

    it('allows only one of two actual database workers to own one recovery item', async () => {
        const call = await createCall('two-workers')
        const finalize = createAiCallFinalizationOperation({
            persistence: crashBeforeFollowUpPort(),
            tasks: actualTaskPort,
            clock: () => BASE,
        })
        await expect(finalize(call.id, finalizationBody(call.id))).rejects.toThrow()

        const now = new Date(BASE.getTime() + OUTBOX_STALE_CLAIM_MS_V1 + 1)
        const publisher = recoveryPublisher(now)
        const [left, right] = await Promise.all([
            publishOutboxBatchV1({
                store: prismaOutboxStoreV1,
                publishers: { [AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1]: publisher },
                now,
            }),
            publishOutboxBatchV1({
                store: prismaOutboxStoreV1,
                publishers: { [AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1]: publisher },
                now,
            }),
        ])
        expect(left.claimed + right.claimed).toBe(1)
        expect(left.published + right.published).toBe(1)
        const taskId = `task_idem_${fingerprint(`ai-call-finalization-follow-up:v1:${call.id}`)}`
        await expect(prisma.task.count({ where: { id: taskId } })).resolves.toBe(1)
    })

    it('runs authenticated callback, transcript revisions, terminal fencing and recovery wiring', async () => {
        const call = await createCall('callback', { session: 'starting' })
        const context = { params: Promise.resolve({ id: call.id }) }

        const greeting = await changeCallState(callbackRequest(`/api/ai-calls/sessions/${call.id}/state`, {
            state: 'greeting',
        }), context)
        expect(greeting.status).toBe(200)
        const active = await changeCallState(callbackRequest(`/api/ai-calls/sessions/${call.id}/state`, {
            state: 'active',
        }), context)
        expect(active.status).toBe(200)

        const second = {
            role: 'assistant', text: 'Second', messageId: `${PREFIX}:message:2`, ordinal: 2, final: true,
        }
        const firstInterim = {
            role: 'user', text: 'Fir', messageId: `${PREFIX}:message:1`, ordinal: 1, final: false,
        }
        const firstFinal = { ...firstInterim, text: 'First', final: true, segmentRevision: 2 }
        for (const body of [second, firstInterim, firstFinal, firstFinal, firstInterim]) {
            const response = await appendTranscriptItem(callbackRequest(
                `/api/ai-calls/sessions/${call.id}/transcript-item`, body,
            ), context)
            expect(response.status).toBe(200)
        }
        const conflict = await appendTranscriptItem(callbackRequest(
            `/api/ai-calls/sessions/${call.id}/transcript-item`,
            { ...firstFinal, text: 'Conflicting same revision' },
        ), context)
        expect(conflict.status).toBe(409)

        const terminal = await finalizeCall(callbackRequest(
            `/api/ai-calls/sessions/${call.id}/finalize`, finalizationBody(call.id),
        ), context)
        expect(terminal.status).toBe(200)
        await expect(terminal.json()).resolves.toMatchObject({
            ok: true,
            callId: call.id,
            followUpStatus: 'completed',
        })

        const late = await appendTranscriptItem(callbackRequest(
            `/api/ai-calls/sessions/${call.id}/transcript-item`,
            { ...firstFinal, text: 'Late correction', segmentRevision: 3 },
        ), context)
        expect(late.status).toBe(409)

        const stored = await prisma.call.findUniqueOrThrow({ where: { id: call.id } })
        expect(stored.transcript).toBe('[Лид] First\n[AI] Second\n')
        expect(stored.aiSessionStatus).toBe('ended')
        expect(readAiCallFinalizationJournal(stored.metadata)?.transcriptRevision).toBe(3)
        await expect(prisma.aiCallMessage.count({ where: { callId: call.id } })).resolves.toBe(2)

        const recovery = await publishOutboxBatchV1({
            store: prismaOutboxStoreV1,
            publishers: {
                [AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1]: recoveryPublisher(
                    new Date(BASE.getTime() + 10_000),
                ),
            },
            now: new Date(BASE.getTime() + 10_000),
        })
        expect(recovery).toMatchObject({ claimed: 1, published: 1 })
    })

    it('normalizes a legacy Call transcript losslessly before appending canonical rows', async () => {
        const call = await createCall('legacy', { transcript: '[Лид] Legacy lead\n[AI] Legacy AI\n' })
        const context = { params: Promise.resolve({ id: call.id }) }
        const response = await appendTranscriptItem(callbackRequest(
            `/api/ai-calls/sessions/${call.id}/transcript-item`,
            { role: 'user', text: 'New turn', messageId: `${PREFIX}:legacy:new`, ordinal: 3, final: true },
        ), context)
        expect(response.status).toBe(200)
        const stored = await prisma.call.findUniqueOrThrow({ where: { id: call.id } })
        expect(stored.transcript).toBe('[Лид] Legacy lead\n[AI] Legacy AI\n[Лид] New turn\n')
        await expect(prisma.aiCallMessage.count({ where: { callId: call.id } })).resolves.toBe(3)
    })
})
