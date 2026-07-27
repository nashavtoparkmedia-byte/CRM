import { randomUUID } from 'node:crypto'
import type { NormalizeRawObservationInput } from '../inbound/types.ts'
import { MAX_SHADOW_COMPARISON_MAX_BATCH } from './constants.ts'
import { ShadowComparisonError } from './errors.ts'
import type {
  CompareBatchInput,
  CompareBatchResult,
  CompareObservationInput,
  CompareObservationResult,
  ComparisonClassification,
  CreateComparisonRunInput,
  ListResultsInput,
  SemanticComparisonEngine,
  ShadowComparisonCursorRecord,
  ShadowComparisonResultRecord,
  ShadowComparisonRunRecord,
  ShadowSemanticComparisonHarness,
  ShadowSemanticDiffRecord,
} from './types.ts'

type PrismaClientLike = any
type FailurePoint = 'after_result' | 'during_diffs' | 'before_counter'
type FailureInjector = (point: FailurePoint) => void

const classifications: readonly ComparisonClassification[] = [
  'matched', 'expected_difference', 'regression', 'legacy_only',
  'new_only', 'unsupported', 'quarantined',
]

function required(value: string, field: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new ShadowComparisonError('INVALID_INPUT', `${field} must be an exact nonempty value`)
  }
}

function boundedLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SHADOW_COMPARISON_MAX_BATCH) {
    throw new ShadowComparisonError('INVALID_INPUT', `limit must be between 1 and ${MAX_SHADOW_COMPARISON_MAX_BATCH}`)
  }
}

function prismaCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object'
    ? Reflect.get(error, 'code') as string | undefined
    : undefined
}

function runRecord(value: unknown): ShadowComparisonRunRecord {
  return value as ShadowComparisonRunRecord
}

function resultRecord(value: unknown): ShadowComparisonResultRecord {
  return value as ShadowComparisonResultRecord
}

function diffRecord(value: unknown): ShadowSemanticDiffRecord {
  return value as ShadowSemanticDiffRecord
}

function cursorRecord(value: unknown): ShadowComparisonCursorRecord {
  return value as ShadowComparisonCursorRecord
}

function counterField(classification: ComparisonClassification): string {
  return classification === 'matched' ? 'matchedCount'
    : classification === 'expected_difference' ? 'expectedDifferenceCount'
      : classification === 'regression' ? 'regressionCount'
        : classification === 'legacy_only' ? 'legacyOnlyCount'
          : classification === 'new_only' ? 'newOnlyCount'
            : classification === 'unsupported' ? 'unsupportedCount'
              : 'quarantinedCount'
}

function emptyClassificationCounts(): Record<ComparisonClassification, number> {
  return {
    matched: 0,
    expected_difference: 0,
    regression: 0,
    legacy_only: 0,
    new_only: 0,
    unsupported: 0,
    quarantined: 0,
  }
}

export class PrismaShadowSemanticComparisonHarness implements ShadowSemanticComparisonHarness {
  readonly #prisma: PrismaClientLike
  readonly #engine: SemanticComparisonEngine
  readonly #failureInjector?: FailureInjector

  constructor(prisma: PrismaClientLike, engine: SemanticComparisonEngine, failureInjector?: FailureInjector) {
    this.#prisma = prisma
    this.#engine = engine
    this.#failureInjector = failureInjector
  }

  async createRun(input: CreateComparisonRunInput): Promise<ShadowComparisonRunRecord> {
    required(input.accountId, 'accountId')
    required(input.comparisonVersion, 'comparisonVersion')
    required(input.legacyAdapterVersion, 'legacyAdapterVersion')
    required(input.newNormalizerVersion, 'newNormalizerVersion')
    if (input.comparisonVersion !== this.#engine.comparisonVersion
      || input.legacyAdapterVersion !== this.#engine.legacyAdapterVersion
      || input.newNormalizerVersion !== this.#engine.newNormalizerVersion) {
      throw new ShadowComparisonError('INVALID_INPUT', 'comparison component versions must be exact')
    }
    const runId = input.runId ?? randomUUID()
    required(runId, 'runId')
    const from = input.sourceFromJournalSequence
    const to = input.sourceToJournalSequence
    if ((from !== undefined && from < 0n) || (to !== undefined && to < 0n)
      || (from !== undefined && to !== undefined && to < from)) {
      throw new ShadowComparisonError('INVALID_INPUT', 'journal range is invalid')
    }
    const now = input.now ?? new Date()
    const initialCursor = from === undefined || from === 0n ? 0n : from - 1n
    const created = await this.#prisma.$transaction(async (transaction: PrismaClientLike) => {
      const run = await transaction.maxShadowComparisonRun.create({ data: {
        runId,
        accountId: input.accountId,
        comparisonVersion: input.comparisonVersion,
        legacyAdapterVersion: input.legacyAdapterVersion,
        newNormalizerVersion: input.newNormalizerVersion,
        state: 'running',
        sourceFromJournalSequence: from ?? null,
        sourceToJournalSequence: to ?? null,
        startedAt: now,
      } })
      await transaction.maxShadowComparisonCursor.create({ data: {
        cursorId: randomUUID(),
        runId,
        accountId: input.accountId,
        comparisonVersion: input.comparisonVersion,
        lastJournalSequence: initialCursor,
      } })
      return run
    })
    return runRecord(created)
  }

  async compareObservation(input: CompareObservationInput): Promise<CompareObservationResult> {
    required(input.runId, 'runId')
    required(input.accountId, 'accountId')
    required(input.comparisonVersion, 'comparisonVersion')
    required(input.observationId, 'observationId')
    const existing = await this.getResult(input.accountId, input.runId, input.observationId, input.comparisonVersion)
    if (existing !== null) return { ...existing, idempotent: true }
    const run = await this.#loadRun(input.accountId, input.runId, input.comparisonVersion)
    if (run.state !== 'running') throw new ShadowComparisonError('RUN_NOT_RUNNING', 'comparison run is not running')
    const raw = await this.#prisma.maxRawTransportEvent.findFirst({
      where: { accountId: input.accountId, observationId: input.observationId },
    })
    if (raw === null) throw new ShadowComparisonError('OBSERVATION_NOT_FOUND', 'raw observation was not found in the requested account')
    if (run.sourceFromJournalSequence !== null && raw.journalSequence < run.sourceFromJournalSequence
      || run.sourceToJournalSequence !== null && raw.journalSequence > run.sourceToJournalSequence) {
      throw new ShadowComparisonError('INVALID_INPUT', 'raw observation is outside the run journal range')
    }
    const normalizedInput: NormalizeRawObservationInput = {
      accountId: raw.accountId,
      observationId: raw.observationId,
      journalSequence: raw.journalSequence,
      observedAt: raw.observedAt,
      sourceTransport: raw.sourceTransport,
      sourceOrigin: raw.sourceOrigin,
      historyLive: raw.historyLive,
      payloadEncoding: raw.payloadEncoding,
      sanitizedPayload: raw.sanitizedPayload,
      payloadSha256: raw.payloadSha256,
      captureAdapterVersion: raw.captureAdapterVersion,
      parserVersion: this.#engine.newNormalizerVersion,
      opcode: raw.opcode ?? undefined,
      eventType: raw.eventType ?? undefined,
      replayAvailability: raw.replayAvailability,
      quarantineReason: raw.quarantineReason ?? undefined,
    }
    const comparison = this.#engine.compare(normalizedInput)
    let created = false
    try {
      const resultId = randomUUID()
      await this.#prisma.$transaction(async (transaction: PrismaClientLike) => {
        const raced = await transaction.maxShadowComparisonResult.findUnique({
          where: { runId_sourceObservationId_comparisonVersion: {
            runId: input.runId,
            sourceObservationId: input.observationId,
            comparisonVersion: input.comparisonVersion,
          } },
        })
        if (raced !== null) return
        await transaction.maxShadowComparisonResult.create({ data: {
          resultId,
          runId: input.runId,
          accountId: input.accountId,
          sourceObservationId: input.observationId,
          sourceJournalSequence: raw.journalSequence,
          comparisonVersion: input.comparisonVersion,
          classification: comparison.classification,
          legacyStatus: comparison.legacy.status,
          newStatus: comparison.current.status,
          legacySemanticSha256: comparison.legacy.semanticSha256,
          newSemanticSha256: comparison.current.semanticSha256,
          diffCount: comparison.diffs.length,
          highestSeverity: comparison.highestSeverity,
          issueCode: comparison.issueCode,
          safeSummary: comparison.safeSummary,
        } })
        this.#failureInjector?.('after_result')
        for (const diff of comparison.diffs) {
          this.#failureInjector?.('during_diffs')
          await transaction.maxShadowSemanticDiff.create({ data: {
            diffId: randomUUID(),
            resultId,
            accountId: input.accountId,
            diffOrdinal: diff.diffOrdinal,
            path: diff.path,
            differenceKind: diff.differenceKind,
            severity: diff.severity,
            legacyValueType: diff.legacyValueType,
            newValueType: diff.newValueType,
            legacyValueHash: diff.legacyValueHash,
            newValueHash: diff.newValueHash,
            safeMetadata: diff.safeMetadata,
          } })
        }
        this.#failureInjector?.('before_counter')
        await transaction.maxShadowComparisonRun.update({
          where: { runId: input.runId },
          data: {
            processedCount: { increment: 1 },
            [counterField(comparison.classification)]: { increment: 1 },
          },
        })
        created = true
      })
    } catch (error) {
      if (prismaCode(error) !== 'P2002') throw error
    }
    const stored = await this.getResult(input.accountId, input.runId, input.observationId, input.comparisonVersion)
    if (stored === null) throw new ShadowComparisonError('COMPARISON_TRANSACTION_FAILED', 'comparison transaction did not create a durable result')
    return { ...stored, idempotent: !created }
  }

  async compareBatch(input: CompareBatchInput): Promise<CompareBatchResult> {
    boundedLimit(input.limit)
    const run = await this.#loadRun(input.accountId, input.runId, input.comparisonVersion)
    if (run.state !== 'running') throw new ShadowComparisonError('RUN_NOT_RUNNING', 'comparison run is not running')
    const cursor = await this.getCursor(input.accountId, input.runId, input.comparisonVersion)
    if (cursor === null) throw new ShadowComparisonError('RUN_SCOPE_MISMATCH', 'run cursor is missing')
    const where: Record<string, unknown> = {
      accountId: input.accountId,
      journalSequence: { gt: cursor.lastJournalSequence },
    }
    if (run.sourceToJournalSequence !== null) {
      where.journalSequence = { gt: cursor.lastJournalSequence, lte: run.sourceToJournalSequence }
    }
    const observations = await this.#prisma.maxRawTransportEvent.findMany({
      where,
      orderBy: { journalSequence: 'asc' },
      take: input.limit,
    })
    const counts = emptyClassificationCounts()
    let idempotent = 0
    let currentCursor = cursor
    for (const observation of observations) {
      const compared = await this.compareObservation({
        runId: input.runId,
        accountId: input.accountId,
        comparisonVersion: input.comparisonVersion,
        observationId: observation.observationId,
      })
      counts[compared.result.classification] += 1
      if (compared.idempotent) idempotent += 1
      currentCursor = await this.advanceCursor(
        input.accountId,
        input.runId,
        input.comparisonVersion,
        observation.journalSequence,
        currentCursor.optimisticVersion,
      )
    }
    return {
      processed: observations.length,
      idempotent,
      classifications: counts,
      lastJournalSequence: currentCursor.lastJournalSequence,
    }
  }

  resumeRun(input: CompareBatchInput): Promise<CompareBatchResult> {
    return this.compareBatch(input)
  }

  replayObservation(input: CompareObservationInput): Promise<CompareObservationResult> {
    return this.compareObservation(input)
  }

  async getRun(accountId: string, runId: string): Promise<ShadowComparisonRunRecord | null> {
    const value = await this.#prisma.maxShadowComparisonRun.findFirst({ where: { accountId, runId } })
    return value === null ? null : runRecord(value)
  }

  async getResult(
    accountId: string,
    runId: string,
    observationId: string,
    comparisonVersion: string,
  ): Promise<CompareObservationResult | null> {
    const value = await this.#prisma.maxShadowComparisonResult.findFirst({
      where: { accountId, runId, sourceObservationId: observationId, comparisonVersion },
      include: { diffs: { orderBy: { diffOrdinal: 'asc' } } },
    })
    if (value === null) return null
    return {
      result: resultRecord(value),
      diffs: value.diffs.map(diffRecord),
      idempotent: true,
    }
  }

  async listResults(input: ListResultsInput): Promise<readonly ShadowComparisonResultRecord[]> {
    boundedLimit(input.limit)
    const values = await this.#prisma.maxShadowComparisonResult.findMany({
      where: {
        accountId: input.accountId,
        runId: input.runId,
        ...(input.classification === undefined ? {} : { classification: input.classification }),
        ...(input.afterJournalSequence === undefined ? {} : { sourceJournalSequence: { gt: input.afterJournalSequence } }),
      },
      orderBy: [{ sourceJournalSequence: 'asc' }, { resultId: 'asc' }],
      take: input.limit,
    })
    return values.map(resultRecord)
  }

  async listCriticalDiffs(accountId: string, runId: string, limit: number): Promise<readonly ShadowSemanticDiffRecord[]> {
    boundedLimit(limit)
    const values = await this.#prisma.maxShadowSemanticDiff.findMany({
      where: { accountId, severity: 'critical', result: { runId } },
      orderBy: [{ createdAt: 'asc' }, { diffOrdinal: 'asc' }],
      take: limit,
    })
    return values.map(diffRecord)
  }

  async listRegressions(accountId: string, runId: string, limit: number): Promise<readonly ShadowComparisonResultRecord[]> {
    return this.listResults({ accountId, runId, classification: 'regression', limit })
  }

  async getCursor(accountId: string, runId: string, comparisonVersion: string): Promise<ShadowComparisonCursorRecord | null> {
    const value = await this.#prisma.maxShadowComparisonCursor.findFirst({
      where: { accountId, runId, comparisonVersion },
    })
    return value === null ? null : cursorRecord(value)
  }

  async advanceCursor(
    accountId: string,
    runId: string,
    comparisonVersion: string,
    journalSequence: bigint,
    expectedVersion: number,
  ): Promise<ShadowComparisonCursorRecord> {
    if (journalSequence < 0n || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new ShadowComparisonError('INVALID_INPUT', 'cursor values are invalid')
    }
    const update = await this.#prisma.maxShadowComparisonCursor.updateMany({
      where: {
        accountId,
        runId,
        comparisonVersion,
        optimisticVersion: expectedVersion,
        lastJournalSequence: { lte: journalSequence },
      },
      data: {
        lastJournalSequence: journalSequence,
        optimisticVersion: { increment: 1 },
      },
    })
    if (update.count !== 1) throw new ShadowComparisonError('CURSOR_CONFLICT', 'comparison cursor optimistic conflict')
    const cursor = await this.getCursor(accountId, runId, comparisonVersion)
    if (cursor === null) throw new ShadowComparisonError('RUN_SCOPE_MISMATCH', 'comparison cursor disappeared')
    return cursor
  }

  async completeRun(accountId: string, runId: string, comparisonVersion: string, now = new Date()): Promise<ShadowComparisonRunRecord> {
    await this.#loadRun(accountId, runId, comparisonVersion)
    const value = await this.#prisma.maxShadowComparisonRun.update({
      where: { runId },
      data: { state: 'completed', completedAt: now },
    })
    return runRecord(value)
  }

  async #loadRun(accountId: string, runId: string, comparisonVersion: string): Promise<ShadowComparisonRunRecord> {
    const run = await this.#prisma.maxShadowComparisonRun.findUnique({ where: { runId } })
    if (run === null) throw new ShadowComparisonError('RUN_NOT_FOUND', 'comparison run was not found')
    if (run.accountId !== accountId || run.comparisonVersion !== comparisonVersion) {
      throw new ShadowComparisonError('RUN_SCOPE_MISMATCH', 'comparison run account/version scope mismatch')
    }
    return runRecord(run)
  }
}

export { classifications as SHADOW_COMPARISON_CLASSIFICATIONS }
