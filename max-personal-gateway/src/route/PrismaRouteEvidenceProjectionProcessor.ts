import { createHash } from 'node:crypto'

import { MAX_INBOUND_BATCH_LIMIT } from '../inbound/constants.ts'
import type {
  NormalizeObservationResult,
  NormalizedTransportEvent,
  RouteEvidenceEnvelope,
  ShadowInboundNormalizationProcessor,
} from '../inbound/types.ts'
import type { RawEventJournal } from '../journal/RawEventJournal.ts'
import type { RawTransportObservation } from '../journal/types.ts'
import type { RouteRegistry } from './RouteRegistry.ts'
import type {
  ObserveRouteEvidenceResult,
  RouteEvidenceAuthority,
  RouteIdentityEvidence,
  RouteIdentityKind,
} from './types.ts'

const ROUTE_REGISTRY_PROJECTION_CONSUMER = 'max-personal-gateway-route-registry-v1'
export const MAX_ROUTE_REGISTRY_PROJECTION_VERSION = 'max-route-registry-projection-v1'

export interface ProjectRouteEvidenceBatchInput {
  readonly accountId: string
  readonly parserVersion: string
  readonly workerId: string
  readonly limit: number
  readonly consumerId?: string
  readonly extractorVersion?: string
}

export interface ProjectRouteEvidenceBatchResult {
  readonly processed: number
  readonly applied: number
  readonly routeObservations: number
  readonly conflicts: number
  readonly idempotent: number
  readonly skipped: number
  readonly lastJournalSequence: bigint
}

type RouteEvent = NormalizedTransportEvent & { normalizedPayload: RouteEvidenceEnvelope }

function required(value: string, field: string): void {
  if (value.length === 0 || value !== value.trim()) throw new Error(`${field} is required and must be exact`)
}

function stableSha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function isRouteEvent(event: NormalizedTransportEvent): event is RouteEvent {
  if (event.eventKind !== 'route_evidence') return false
  const payload = event.normalizedPayload as Partial<RouteEvidenceEnvelope>
  return Boolean(
    payload
      && payload.mutationPerformed === false
      && (payload.identityKind === 'provider_user_id'
        || payload.identityKind === 'protocol_chat_id'
        || payload.identityKind === 'web_route_id')
      && typeof payload.identityValue === 'string'
      && payload.identityValue.length > 0
      && (payload.authority === 'provider_exact'
        || payload.authority === 'protocol_exact'
        || payload.authority === 'web_route_observed'),
  )
}

function chooseAuthority(events: readonly RouteEvent[]): Exclude<RouteEvidenceAuthority, 'manual_approved'> {
  if (events.some(event => event.normalizedPayload.authority === 'protocol_exact')) return 'protocol_exact'
  if (events.some(event => event.normalizedPayload.authority === 'provider_exact')) return 'provider_exact'
  return 'web_route_observed'
}

function chooseObservedAt(raw: RawTransportObservation, events: readonly RouteEvent[]): Date {
  return events.reduce((latest, event) => {
    if (event.providerOccurredAt === null) return latest
    return event.providerOccurredAt.getTime() > latest.getTime() ? event.providerOccurredAt : latest
  }, raw.observedAt)
}

function aggregateRouteIdentities(events: readonly RouteEvent[]): {
  readonly identities: RouteIdentityEvidence[]
  readonly skippedDuplicateKind: boolean
} {
  const byKind = new Map<RouteIdentityKind, string>()
  for (const event of events) {
    const kind = event.normalizedPayload.identityKind
    const value = event.normalizedPayload.identityValue
    const existing = byKind.get(kind)
    if (existing !== undefined && existing !== value) {
      return { identities: [], skippedDuplicateKind: true }
    }
    byKind.set(kind, value)
  }
  const priority: readonly RouteIdentityKind[] = ['protocol_chat_id', 'provider_user_id', 'web_route_id']
  return {
    identities: priority.flatMap(kind => {
      const value = byKind.get(kind)
      return value === undefined ? [] : [{ kind, value }]
    }),
    skippedDuplicateKind: false,
  }
}

function safeEvidence(
  raw: RawTransportObservation,
  result: NormalizeObservationResult,
  events: readonly RouteEvent[],
  identities: readonly RouteIdentityEvidence[],
): Record<string, unknown> {
  return {
    projectionVersion: MAX_ROUTE_REGISTRY_PROJECTION_VERSION,
    sourceObservationId: raw.observationId,
    sourceJournalSequence: raw.journalSequence.toString(),
    parserVersion: result.result.parserVersion,
    normalizationResultId: result.result.normalizationResultId,
    routeEventIds: events.map(event => event.normalizedEventId),
    routeEventOrdinals: events.map(event => event.eventOrdinal),
    origins: [...new Set(events.map(event => event.origin))].sort(),
    directions: [...new Set(events.map(event => event.direction))].sort(),
    authorities: [...new Set(events.map(event => event.normalizedPayload.authority))].sort(),
    identities,
  }
}

function sourceEvidenceKey(
  raw: RawTransportObservation,
  parserVersion: string,
  identities: readonly RouteIdentityEvidence[],
): string {
  const fingerprint = stableSha({
    observationId: raw.observationId,
    parserVersion,
    identities,
  }).slice(0, 32)
  return `${MAX_ROUTE_REGISTRY_PROJECTION_VERSION}:${raw.observationId}:${fingerprint}`
}

export class PrismaRouteEvidenceProjectionProcessor {
  readonly #journal: RawEventJournal
  readonly #normalizer: ShadowInboundNormalizationProcessor
  readonly #routeRegistry: RouteRegistry
  readonly #clock: () => Date

  constructor(
    journal: RawEventJournal,
    normalizer: ShadowInboundNormalizationProcessor,
    routeRegistry: RouteRegistry,
    options: { readonly clock?: () => Date } = {},
  ) {
    this.#journal = journal
    this.#normalizer = normalizer
    this.#routeRegistry = routeRegistry
    this.#clock = options.clock ?? (() => new Date())
  }

  async projectBatch(input: ProjectRouteEvidenceBatchInput): Promise<ProjectRouteEvidenceBatchResult> {
    required(input.accountId, 'accountId')
    required(input.parserVersion, 'parserVersion')
    required(input.workerId, 'workerId')
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_INBOUND_BATCH_LIMIT) {
      throw new Error(`limit must be between 1 and ${MAX_INBOUND_BATCH_LIMIT}`)
    }
    const consumerId = input.consumerId ?? ROUTE_REGISTRY_PROJECTION_CONSUMER
    const extractorVersion = input.extractorVersion ?? MAX_ROUTE_REGISTRY_PROJECTION_VERSION
    required(consumerId, 'consumerId')
    required(extractorVersion, 'extractorVersion')

    let cursor = await this.#journal.getCursor(consumerId, input.accountId, input.parserVersion)
    const page = await this.#journal.readAfter(input.accountId, cursor?.lastJournalSequence ?? 0n, input.limit)
    let applied = 0
    let routeObservations = 0
    let conflicts = 0
    let idempotent = 0
    let skipped = 0

    for (const raw of page.observations) {
      const normalized = await this.#normalizer.normalizeObservation({
        accountId: input.accountId,
        observationId: raw.observationId,
        parserVersion: input.parserVersion,
        workerId: input.workerId,
        now: this.#clock(),
      })
      const routeEvents = normalized.events.filter(isRouteEvent)
      if (routeEvents.length === 0 || normalized.result.status !== 'normalized') {
        skipped += 1
      } else {
        const aggregated = aggregateRouteIdentities(routeEvents)
        if (aggregated.skippedDuplicateKind || aggregated.identities.length === 0) {
          skipped += 1
        } else {
          const result: ObserveRouteEvidenceResult = await this.#routeRegistry.observeRouteEvidence({
            accountId: input.accountId,
            sourceEvidenceKey: sourceEvidenceKey(raw, input.parserVersion, aggregated.identities),
            sourceRawObservationId: raw.observationId,
            extractorVersion,
            observedAt: chooseObservedAt(raw, routeEvents),
            evidenceSource: 'normalized_route_evidence',
            evidenceAuthority: chooseAuthority(routeEvents),
            identities: aggregated.identities,
            evidence: safeEvidence(raw, normalized, routeEvents, aggregated.identities),
          })
          applied += 1
          routeObservations += result.routeObservationIds.length
          if (result.conflictId !== undefined || result.state === 'conflicted') conflicts += 1
          if (result.idempotent) idempotent += 1
        }
      }
      cursor = await this.#journal.advanceCursor({
        consumerId,
        accountId: input.accountId,
        parserVersion: input.parserVersion,
        lastJournalSequence: raw.journalSequence,
        expectedVersion: cursor?.version ?? 0,
      })
    }

    return {
      processed: page.observations.length,
      applied,
      routeObservations,
      conflicts,
      idempotent,
      skipped,
      lastJournalSequence: cursor?.lastJournalSequence ?? 0n,
    }
  }
}
