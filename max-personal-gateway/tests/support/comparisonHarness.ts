import { Buffer } from 'node:buffer'
import { MAX_INBOUND_NORMALIZER_VERSION } from '../../src/inbound/constants.ts'
import { PrismaRawEventJournal } from '../../src/journal/PrismaRawEventJournal.ts'
import type { SanitizedObservationInput } from '../../src/journal/types.ts'
import {
  MAX_LEGACY_SEMANTIC_ADAPTER_VERSION,
  MAX_SHADOW_COMPARISON_VERSION,
} from '../../src/comparison/constants.ts'
import type { PrismaShadowSemanticComparisonHarness } from '../../src/comparison/PrismaShadowSemanticComparisonHarness.ts'
import type { SafeComparisonFixture } from './comparisonFixtures.ts'
import { comparisonInput } from './comparisonFixtures.ts'

export async function appendComparisonFixture(
  journal: PrismaRawEventJournal,
  accountId: string,
  fixture: SafeComparisonFixture,
  observationSuffix: string,
): Promise<string> {
  const normalized = comparisonInput(fixture, accountId, 0n, `fixture-${observationSuffix}`)
  const payloadBytes = Buffer.byteLength(JSON.stringify(fixture.payload), 'utf8')
  const observation: SanitizedObservationInput = {
    accountId,
    observedAt: normalized.observedAt,
    sourceTransport: normalized.sourceTransport,
    sourceOrigin: normalized.sourceOrigin,
    historyLive: fixture.historyLive ?? 'live',
    payloadEncoding: 'json',
    sanitizedPayload: fixture.payload,
    payloadSha256: normalized.payloadSha256,
    payloadSizeBytes: payloadBytes,
    replayAvailability: fixture.replayAvailability ?? 'available',
    quarantineReason: fixture.replayAvailability === 'quarantined' ? 'unsupported_payload' : undefined,
    sanitizerVersion: 'stage7-safe-fixture-sanitizer-v1',
    captureAdapterVersion: 'stage7-safe-fixture-v1',
    schemaVersion: 1,
    redactionMetadata: { sanitizerVersion: 'stage7-safe-fixture-sanitizer-v1', categories: [], paths: [] },
    quarantineEligible: true,
    parserVersion: MAX_INBOUND_NORMALIZER_VERSION,
  }
  return journal.append(observation)
}

export async function createComparisonRun(
  harness: PrismaShadowSemanticComparisonHarness,
  accountId: string,
  runId: string,
): Promise<void> {
  await harness.createRun({
    runId,
    accountId,
    comparisonVersion: MAX_SHADOW_COMPARISON_VERSION,
    legacyAdapterVersion: MAX_LEGACY_SEMANTIC_ADAPTER_VERSION,
    newNormalizerVersion: MAX_INBOUND_NORMALIZER_VERSION,
    now: new Date('2026-07-27T14:30:00.000Z'),
  })
}
