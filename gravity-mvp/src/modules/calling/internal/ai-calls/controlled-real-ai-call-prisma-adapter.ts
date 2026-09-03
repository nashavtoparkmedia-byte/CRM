import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type {
    ControlledRealAiCallPersistencePort,
    ControlledRealAiCallRecord,
    ControlledRealAiCallStorageClaim,
} from '../../application/controlled-real-ai-call-admission'

const callSelect = {
    id: true,
    fsUuid: true,
    managerId: true,
    toNumber: true,
    aiScenarioId: true,
    isAi: true,
    isSimulation: true,
    status: true,
    aiSessionStatus: true,
    metadata: true,
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUniqueConstraintError(error: unknown): boolean {
    return isRecord(error) && error.code === 'P2002'
}

function storedFingerprint(metadata: unknown): string | null {
    if (!isRecord(metadata)) return null
    const controlled = metadata.controlledRealCallV1
    if (!isRecord(controlled)) return null
    return typeof controlled.requestFingerprint === 'string'
        ? controlled.requestFingerprint
        : null
}

function matchesClaim(call: ControlledRealAiCallRecord, claim: ControlledRealAiCallStorageClaim): boolean {
    return call.fsUuid === claim.fsUuid
        && call.managerId === claim.input.actorId
        && call.toNumber === claim.input.toNumber
        && call.aiScenarioId === claim.input.scenarioId
        && call.isAi
        && !call.isSimulation
        && storedFingerprint(call.metadata) === claim.requestFingerprint
}

async function findCall(id: string): Promise<ControlledRealAiCallRecord | null> {
    return prisma.call.findUnique({ where: { id }, select: callSelect })
}

function inputMetadata(claim: ControlledRealAiCallStorageClaim): Prisma.InputJsonObject {
    return {
        controlledRealCallV1: {
            version: 1,
            requestId: claim.input.requestId,
            requestFingerprint: claim.requestFingerprint,
            confirmedAt: new Date().toISOString(),
            confirmationVersion: 1,
            attemptLimit: 1,
            automaticRetry: false,
            dispatchState: 'claimed',
            providers: claim.input.providers,
        },
    }
}

function withDispatchState(
    metadata: Prisma.JsonValue,
    input: Parameters<ControlledRealAiCallPersistencePort['recordDispatch']>[0],
): Prisma.InputJsonObject {
    const root = isRecord(metadata) ? metadata : {}
    const current = isRecord(root.controlledRealCallV1) ? root.controlledRealCallV1 : {}
    return {
        ...root,
        controlledRealCallV1: {
            ...current,
            dispatchState: input.state,
            dispatchRecordedAt: input.recordedAt.toISOString(),
            ...(input.providerReference ? { providerReference: input.providerReference } : {}),
            ...(input.failureCode ? { failureCode: input.failureCode } : {}),
        },
    } as Prisma.InputJsonObject
}

export const controlledRealAiCallPrismaPort: ControlledRealAiCallPersistencePort = {
    async claim(claim) {
        const existing = await findCall(claim.callId)
        if (existing) {
            return matchesClaim(existing, claim)
                ? { kind: 'duplicate', call: existing }
                : { kind: 'conflict' }
        }

        try {
            const call = await prisma.call.create({
                data: {
                    id: claim.callId,
                    direction: 'outbound',
                    status: 'ringing',
                    fromNumber: claim.input.fromNumber,
                    toNumber: claim.input.toNumber,
                    driverId: claim.input.driverId,
                    contactId: claim.input.contactId,
                    managerId: claim.input.actorId,
                    fsUuid: claim.fsUuid,
                    startedAt: new Date(),
                    isAi: true,
                    isSimulation: false,
                    aiScenarioId: claim.input.scenarioId,
                    aiSessionStatus: 'starting',
                    metadata: inputMetadata(claim),
                },
                select: callSelect,
            })
            return { kind: 'claimed', call }
        } catch (error) {
            if (!isUniqueConstraintError(error)) throw error
            const raced = await findCall(claim.callId)
            return raced && matchesClaim(raced, claim)
                ? { kind: 'duplicate', call: raced }
                : { kind: 'conflict' }
        }
    },

    async recordDispatch(input) {
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Call" WHERE "id" = ${input.callId} FOR UPDATE`)
            const call = await tx.call.findUnique({
                where: { id: input.callId },
                select: { metadata: true },
            })
            if (!call || storedFingerprint(call.metadata) !== input.requestFingerprint) {
                throw new Error('controlled real call dispatch identity mismatch')
            }
            await tx.call.update({
                where: { id: input.callId },
                data: {
                    metadata: withDispatchState(call.metadata, input),
                    ...(input.state === 'rejected' ? {
                        endedAt: input.recordedAt,
                        hangupCause: 'PROVIDER_ORIGINATE_FAILED',
                    } : {}),
                },
            })
        })
    },
}
