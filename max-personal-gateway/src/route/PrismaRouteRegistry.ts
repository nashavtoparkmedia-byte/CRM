import { createHash, randomUUID } from 'node:crypto'
import { RouteRegistryError, asRouteDatabaseError } from './errors.ts'
import type { RouteRegistry } from './RouteRegistry.ts'
import { sanitizeRouteEvidence } from './evidenceSanitizer.ts'
import type {
  ConflictPage,
  ObserveRouteEvidenceInput,
  ObserveRouteEvidenceResult,
  ResolveConflictInput,
  RetireConversationInput,
  RouteConflict,
  RouteConflictStatus,
  RouteEvidenceAuthority,
  RouteIdentityEvidence,
  RouteIdentityKind,
  RouteIdentitySnapshot,
  RouteIdentityStatus,
  RouteObservationResult,
  RouteSnapshot,
  RouteState,
  SendableRouteSnapshot,
  SupersedeIdentityInput,
} from './types.ts'
import type { JsonValue, RedactionEvidence } from '../journal/types.ts'

const MAX_LIST_LIMIT = 100
const MAX_EXACT_VALUE_LENGTH = 512
const EXACT_AUTHORITIES: ReadonlySet<RouteEvidenceAuthority> = new Set(['protocol_exact', 'provider_exact'])
const EVIDENCE_AUTHORITIES: ReadonlySet<RouteEvidenceAuthority> = new Set([
  'protocol_exact',
  'provider_exact',
  'web_route_observed',
  'legacy_import',
  'manual_approved',
])
const IDENTITY_KINDS: ReadonlySet<RouteIdentityKind> = new Set([
  'provider_user_id',
  'protocol_chat_id',
  'web_route_id',
])
const ROUTE_STATES: ReadonlySet<RouteState> = new Set(['unresolved', 'active', 'conflicted', 'retired'])
const IDENTITY_STATES: ReadonlySet<RouteIdentityStatus> = new Set(['provisional', 'active', 'superseded', 'conflicted'])
const CONFLICT_STATES: ReadonlySet<RouteConflictStatus> = new Set(['open', 'resolved', 'dismissed'])

interface ConversationRecord {
  id: string
  accountId: string
  conversationKey: string
  routeVersion: number
  optimisticVersion: number
  state: string
  retiredAt: Date | null
  retiredBy: string | null
  retirementReason: string | null
  createdAt: Date
  updatedAt: Date
}

interface IdentityRecord {
  id: string
  accountId: string
  identityKind: string
  identityValue: string
  conversationKey: string
  status: string
  firstSeenAt: Date
  lastSeenAt: Date
  evidenceRef: string
  version: number
  createdAt: Date
  updatedAt: Date
}

interface ObservationRecord {
  routeObservationId: string
  accountId: string
  idempotencyKey: string
  sourceRawObservationId: string | null
  extractorVersion: string
  observedAt: Date
  evidenceSource: string
  evidenceAuthority: string
  candidateConversationKey: string | null
  identityKind: string
  identityValue: string
  sanitizedEvidence: JsonValue
  evidenceSha256: string
  evidenceSizeBytes: number
  evidenceQuarantined: boolean
  redactionMetadata: RedactionEvidence
  processingResult: string
  routeVersionAfter: number | null
  createdAt: Date
}

interface ConflictRecord {
  conflictId: string
  accountId: string
  identityKind: string
  identityValue: string
  incumbentConversationKey: string
  candidateConversationKey: string
  sourceRouteObservationId: string
  status: string
  expectedRouteVersion: number
  version: number
  createdAt: Date
  resolvedAt: Date | null
  resolutionReason: string | null
  resolvedBy: string | null
  auditMetadata: JsonValue | null
}

interface RawRecord {
  observationId: string
  accountId: string
}

interface ConversationDelegate {
  create(args: { data: Record<string, unknown> }): Promise<ConversationRecord>
  findUnique(args: { where: Record<string, unknown> }): Promise<ConversationRecord | null>
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
}

interface IdentityDelegate {
  create(args: { data: Record<string, unknown> }): Promise<IdentityRecord>
  findUnique(args: { where: Record<string, unknown> }): Promise<IdentityRecord | null>
  findMany(args: { where: Record<string, unknown>; orderBy?: Record<string, 'asc'> }): Promise<IdentityRecord[]>
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
}

interface ObservationDelegate {
  create(args: { data: Record<string, unknown> }): Promise<ObservationRecord>
  findUnique(args: { where: Record<string, unknown> }): Promise<ObservationRecord | null>
}

interface ConflictDelegate {
  create(args: { data: Record<string, unknown> }): Promise<ConflictRecord>
  findUnique(args: { where: Record<string, unknown> }): Promise<ConflictRecord | null>
  findMany(args: {
    where: Record<string, unknown>
    orderBy?: Record<string, 'asc'>
    take?: number
  }): Promise<ConflictRecord[]>
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
}

interface RawDelegate {
  findUnique(args: { where: Record<string, unknown> }): Promise<RawRecord | null>
}

export interface RouteRegistryPrismaTransaction {
  readonly maxRouteConversation: ConversationDelegate
  readonly maxRouteIdentityBinding: IdentityDelegate
  readonly maxRouteObservation: ObservationDelegate
  readonly maxRouteConflict: ConflictDelegate
  readonly maxRawTransportEvent: RawDelegate
}

export interface RouteRegistryPrismaClient extends RouteRegistryPrismaTransaction {
  $transaction<T>(operation: (transaction: RouteRegistryPrismaTransaction) => Promise<T>): Promise<T>
}

export interface PrismaRouteRegistryOptions {
  readonly idGenerator?: () => string
  readonly conversationKeyGenerator?: () => string
  readonly maxEvidenceBytes?: number
}

interface ObservationPlan {
  readonly identity: RouteIdentityEvidence
  readonly existing: IdentityRecord | null
  readonly action: 'create_active' | 'create_provisional' | 'promote' | 'confirm' | 'requires_supersede' | 'ignore_weak'
  readonly result: RouteObservationResult
  readonly idempotencyKey: string
  readonly existingObservation: ObservationRecord | null
}

function required(value: unknown, field: string, maxLength = 256): asserts value is string {
  if (typeof value !== 'string') throw new RouteRegistryError('INVALID_INPUT', `${field} must be a string`)
  if (value.length === 0) throw new RouteRegistryError('INVALID_INPUT', `${field} is required`)
  if (value !== value.trim()) throw new RouteRegistryError('INVALID_INPUT', `${field} must not have outer whitespace`)
  if (value.length > maxLength) throw new RouteRegistryError('INVALID_INPUT', `${field} is too long`)
  if (/\p{Cc}/u.test(value)) throw new RouteRegistryError('INVALID_INPUT', `${field} contains control characters`)
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RouteRegistryError('INVALID_INPUT', `${field} must be a non-negative integer`)
  }
}

function validDate(value: unknown, field: string): asserts value is Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RouteRegistryError('INVALID_INPUT', `${field} must be a valid Date`)
  }
}

function latestDate(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right
}

function evidenceAuthority(value: unknown): RouteEvidenceAuthority {
  if (typeof value !== 'string' || !EVIDENCE_AUTHORITIES.has(value as RouteEvidenceAuthority)) {
    throw new RouteRegistryError('INVALID_INPUT', 'Route evidence authority is not supported')
  }
  return value as RouteEvidenceAuthority
}

function identityKind(value: unknown): RouteIdentityKind {
  if (typeof value !== 'string' || !IDENTITY_KINDS.has(value as RouteIdentityKind)) {
    throw new RouteRegistryError('INVALID_INPUT', 'Route identity kind is not supported')
  }
  return value as RouteIdentityKind
}

function routeState(value: unknown): RouteState {
  if (typeof value !== 'string' || !ROUTE_STATES.has(value as RouteState)) {
    throw new RouteRegistryError('DATABASE_FAILURE', 'Persisted route state is invalid')
  }
  return value as RouteState
}

function identityState(value: unknown): RouteIdentityStatus {
  if (typeof value !== 'string' || !IDENTITY_STATES.has(value as RouteIdentityStatus)) {
    throw new RouteRegistryError('DATABASE_FAILURE', 'Persisted identity state is invalid')
  }
  return value as RouteIdentityStatus
}

function conflictState(value: unknown): RouteConflictStatus {
  if (typeof value !== 'string' || !CONFLICT_STATES.has(value as RouteConflictStatus)) {
    throw new RouteRegistryError('DATABASE_FAILURE', 'Persisted conflict state is invalid')
  }
  return value as RouteConflictStatus
}

function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function identityKey(accountId: string, kind: RouteIdentityKind, value: string): Record<string, unknown> {
  return { accountId_identityKind_identityValue: { accountId, identityKind: kind, identityValue: value } }
}

function conversationKey(accountId: string, key: string): Record<string, unknown> {
  return { accountId_conversationKey: { accountId, conversationKey: key } }
}

function observationKey(accountId: string, key: string): Record<string, unknown> {
  return { accountId_idempotencyKey: { accountId, idempotencyKey: key } }
}

function conflictSourceKey(accountId: string, routeObservationId: string): Record<string, unknown> {
  return { accountId_sourceRouteObservationId: { accountId, sourceRouteObservationId: routeObservationId } }
}

function semanticIdempotencyKey(input: ObserveRouteEvidenceInput, identity: RouteIdentityEvidence): string {
  return createHash('sha256').update(JSON.stringify([
    input.sourceEvidenceKey,
    input.sourceRawObservationId ?? null,
    input.extractorVersion,
    identity.kind,
    identity.value,
  ])).digest('hex')
}

function manualIdempotencyKey(sourceEvidenceKey: string, operation: string, kind: RouteIdentityKind, value: string): string {
  return createHash('sha256').update(JSON.stringify([sourceEvidenceKey, operation, kind, value])).digest('hex')
}

function validateIdentities(identities: unknown): asserts identities is readonly RouteIdentityEvidence[] {
  if (!Array.isArray(identities)) {
    throw new RouteRegistryError('INVALID_INPUT', 'Route identities must be an array')
  }
  if (identities.length < 1 || identities.length > 3) {
    throw new RouteRegistryError('INVALID_INPUT', 'One identity per supported kind is required')
  }
  const kinds = new Set<RouteIdentityKind>()
  for (const candidate of identities) {
    if (candidate === null || typeof candidate !== 'object') {
      throw new RouteRegistryError('INVALID_INPUT', 'Route identity must be an object')
    }
    const identity = candidate as RouteIdentityEvidence
    const kind = identityKind(identity.kind)
    required(identity.value, 'identityValue', MAX_EXACT_VALUE_LENGTH)
    if (kinds.has(kind)) throw new RouteRegistryError('INVALID_INPUT', 'Duplicate identity kind is ambiguous')
    kinds.add(kind)
  }
}

function mapIdentity(record: IdentityRecord): RouteIdentitySnapshot {
  return {
    kind: identityKind(record.identityKind),
    value: record.identityValue,
    status: identityState(record.status),
    firstSeenAt: record.firstSeenAt.toISOString(),
    lastSeenAt: record.lastSeenAt.toISOString(),
    evidenceRef: record.evidenceRef,
    version: record.version,
  }
}

function mapConflict(record: ConflictRecord): RouteConflict {
  return deepFreeze({
    conflictId: record.conflictId,
    accountId: record.accountId,
    identityKind: identityKind(record.identityKind),
    identityValue: record.identityValue,
    incumbentConversationKey: record.incumbentConversationKey,
    candidateConversationKey: record.candidateConversationKey,
    sourceRouteObservationId: record.sourceRouteObservationId,
    status: conflictState(record.status),
    expectedRouteVersion: record.expectedRouteVersion,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    resolvedAt: optional(record.resolvedAt)?.toISOString(),
    resolutionReason: optional(record.resolutionReason),
    resolvedBy: optional(record.resolvedBy),
    auditMetadata: optional(record.auditMetadata),
  })
}

async function loadSnapshot(
  transaction: RouteRegistryPrismaTransaction,
  accountId: string,
  key: string,
): Promise<RouteSnapshot | null> {
  const conversation = await transaction.maxRouteConversation.findUnique({ where: conversationKey(accountId, key) })
  if (!conversation) return null
  const records = await transaction.maxRouteIdentityBinding.findMany({
    where: { accountId, conversationKey: key },
    orderBy: { identityKind: 'asc' },
  })
  const openConflicts = await transaction.maxRouteConflict.findMany({
    where: {
      accountId,
      status: 'open',
      OR: [{ incumbentConversationKey: key }, { candidateConversationKey: key }],
    },
    take: 1,
  })
  const identities = records.map(mapIdentity)
  const activeByKind = new Map<RouteIdentityKind, RouteIdentitySnapshot[]>()
  for (const identity of identities.filter(item => item.status === 'active')) {
    const values = activeByKind.get(identity.kind) ?? []
    values.push(identity)
    activeByKind.set(identity.kind, values)
  }
  const single = (kind: RouteIdentityKind): string | undefined => {
    const values = activeByKind.get(kind) ?? []
    return values.length === 1 ? values[0]?.value : undefined
  }
  return deepFreeze({
    accountId,
    conversationKey: key,
    routeVersion: conversation.routeVersion,
    state: routeState(conversation.state),
    identities,
    activeProviderUserId: single('provider_user_id'),
    activeProtocolChatId: single('protocol_chat_id'),
    activeWebRouteId: single('web_route_id'),
    evidenceReferences: [...new Set(identities.map(item => item.evidenceRef))].sort(),
    hasOpenConflict: openConflicts.length > 0,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  })
}

async function bumpConversation(
  transaction: RouteRegistryPrismaTransaction,
  conversation: ConversationRecord,
  state: RouteState,
  extra: Record<string, unknown> = {},
): Promise<ConversationRecord> {
  const result = await transaction.maxRouteConversation.updateMany({
    where: {
      accountId: conversation.accountId,
      conversationKey: conversation.conversationKey,
      routeVersion: conversation.routeVersion,
      optimisticVersion: conversation.optimisticVersion,
    },
    data: {
      state,
      routeVersion: { increment: 1 },
      optimisticVersion: { increment: 1 },
      ...extra,
    },
  })
  if (result.count !== 1) throw new RouteRegistryError('STALE_ROUTE_VERSION', 'Route version changed during mutation')
  const updated = await transaction.maxRouteConversation.findUnique({
    where: conversationKey(conversation.accountId, conversation.conversationKey),
  })
  if (!updated) throw new RouteRegistryError('NOT_FOUND', 'Route disappeared during mutation')
  return updated
}

async function desiredState(
  transaction: RouteRegistryPrismaTransaction,
  accountId: string,
  key: string,
): Promise<RouteState> {
  const conflicts = await transaction.maxRouteConflict.findMany({
    where: { accountId, status: 'open', OR: [{ incumbentConversationKey: key }, { candidateConversationKey: key }] },
    take: 1,
  })
  if (conflicts.length > 0) return 'conflicted'
  const protocols = await transaction.maxRouteIdentityBinding.findMany({
    where: { accountId, conversationKey: key, identityKind: 'protocol_chat_id', status: 'active' },
  })
  return protocols.length === 1 ? 'active' : 'unresolved'
}

export class PrismaRouteRegistry implements RouteRegistry {
  readonly #client: RouteRegistryPrismaClient
  readonly #idGenerator: () => string
  readonly #conversationKeyGenerator: () => string
  readonly #maxEvidenceBytes: number

  constructor(client: RouteRegistryPrismaClient, options: PrismaRouteRegistryOptions = {}) {
    this.#client = client
    this.#idGenerator = options.idGenerator ?? randomUUID
    this.#conversationKeyGenerator = options.conversationKeyGenerator ?? (() => `conv_${randomUUID()}`)
    this.#maxEvidenceBytes = options.maxEvidenceBytes ?? 64 * 1024
    if (!Number.isSafeInteger(this.#maxEvidenceBytes) || this.#maxEvidenceBytes < 128) {
      throw new RouteRegistryError('INVALID_INPUT', 'maxEvidenceBytes must be at least 128')
    }
  }

  async observeRouteEvidence(input: ObserveRouteEvidenceInput): Promise<ObserveRouteEvidenceResult> {
    required(input.accountId, 'accountId', 128)
    required(input.sourceEvidenceKey, 'sourceEvidenceKey', MAX_EXACT_VALUE_LENGTH)
    required(input.extractorVersion, 'extractorVersion', 128)
    required(input.evidenceSource, 'evidenceSource', 128)
    validDate(input.observedAt, 'observedAt')
    if (input.sourceRawObservationId !== undefined) required(input.sourceRawObservationId, 'sourceRawObservationId')
    if (input.candidateConversationKey !== undefined) required(input.candidateConversationKey, 'candidateConversationKey')
    validateIdentities(input.identities)
    const sanitized = sanitizeRouteEvidence(input.evidence, this.#maxEvidenceBytes)
    const authority = evidenceAuthority(input.evidenceAuthority)
    if (authority === 'manual_approved') {
      throw new RouteRegistryError('INVALID_INPUT', 'Manual authority requires an explicit audited mutation')
    }
    const exact = EXACT_AUTHORITIES.has(authority)

    try {
      return await this.#client.$transaction(async transaction => {
        if (input.sourceRawObservationId !== undefined) {
          const raw = await transaction.maxRawTransportEvent.findUnique({
            where: { observationId: input.sourceRawObservationId },
          })
          if (!raw) throw new RouteRegistryError('NOT_FOUND', 'Source raw observation was not found')
          if (raw.accountId !== input.accountId) {
            throw new RouteRegistryError('ACCOUNT_MISMATCH', 'Source raw observation belongs to another account')
          }
        }

        const plans: ObservationPlan[] = []
        for (const identity of input.identities) {
          const key = semanticIdempotencyKey(input, identity)
          plans.push({
            identity,
            existing: await transaction.maxRouteIdentityBinding.findUnique({
              where: identityKey(input.accountId, identity.kind, identity.value),
            }),
            action: 'confirm',
            result: 'confirmed',
            idempotencyKey: key,
            existingObservation: await transaction.maxRouteObservation.findUnique({
              where: observationKey(input.accountId, key),
            }),
          })
        }

        if (plans.every(plan => plan.existingObservation !== null)) {
          const observations = plans.map(plan => plan.existingObservation as ObservationRecord)
          const key = plans.find(plan => plan.existing)?.existing?.conversationKey
            ?? observations.find(item => item.candidateConversationKey)?.candidateConversationKey
          if (!key) throw new RouteRegistryError('DATABASE_FAILURE', 'Idempotent observation has no route reference')
          const snapshot = await loadSnapshot(transaction, input.accountId, key)
          if (!snapshot) throw new RouteRegistryError('NOT_FOUND', 'Idempotent route was not found')
          let conflict: ConflictRecord | null = null
          for (const observation of observations) {
            conflict = await transaction.maxRouteConflict.findUnique({
              where: conflictSourceKey(input.accountId, observation.routeObservationId),
            })
            if (conflict) break
          }
          return deepFreeze({
            accountId: input.accountId,
            conversationKey: key,
            routeVersion: snapshot.routeVersion,
            state: snapshot.state,
            routeObservationIds: observations.map(item => item.routeObservationId),
            processingResults: observations.map(item => item.processingResult as RouteObservationResult),
            conflictId: conflict?.conflictId,
            idempotent: true,
            semanticChange: false,
          })
        }

        const candidate = input.candidateConversationKey
          ? await transaction.maxRouteConversation.findUnique({ where: conversationKey(input.accountId, input.candidateConversationKey) })
          : null
        if (input.candidateConversationKey && !candidate) {
          throw new RouteRegistryError('NOT_FOUND', 'Candidate conversation was not found in account')
        }

        const bindingKeys = [...new Set(plans
          .map(plan => plan.existing)
          .filter((record): record is IdentityRecord => record !== null && record.status !== 'superseded')
          .map(record => record.conversationKey))]
        const allKeys = [...new Set([...bindingKeys, ...(candidate ? [candidate.conversationKey] : [])])]
        for (const key of allKeys) {
          const route = await transaction.maxRouteConversation.findUnique({ where: conversationKey(input.accountId, key) })
          if (route?.state === 'retired') {
            throw new RouteRegistryError('ROUTE_NOT_SENDABLE', 'Retired route cannot accept automatic evidence')
          }
        }

        if (exact && allKeys.length > 1) {
          return await this.#createConflicts(
            transaction,
            input,
            plans,
            bindingKeys,
            candidate?.conversationKey,
            sanitized,
          )
        }

        const boundConversation = bindingKeys[0]
          ? await transaction.maxRouteConversation.findUnique({ where: conversationKey(input.accountId, bindingKeys[0]) })
          : null
        let selected = !exact && boundConversation ? boundConversation : candidate ?? boundConversation
        if (!selected) {
          const generated = this.#conversationKeyGenerator()
          required(generated, 'generatedConversationKey')
          if (input.identities.some(identity => identity.value === generated)) {
            throw new RouteRegistryError('INVALID_INPUT', 'conversationKey must differ from provider identities')
          }
          selected = await transaction.maxRouteConversation.create({
            data: {
              id: this.#idGenerator(),
              accountId: input.accountId,
              conversationKey: generated,
              routeVersion: 0,
              optimisticVersion: 0,
              state: 'unresolved',
            },
          })
        }
        if (selected.state === 'retired') {
          throw new RouteRegistryError('ROUTE_NOT_SENDABLE', 'Retired route cannot accept automatic evidence')
        }

        const activeForConversation = await transaction.maxRouteIdentityBinding.findMany({
          where: { accountId: input.accountId, conversationKey: selected.conversationKey, status: 'active' },
        })
        const activeByKind = new Map(activeForConversation.map(record => [record.identityKind, record]))
        const planned = plans.map(plan => {
          if (plan.existingObservation) return plan
          if (plan.existing) {
            if (!exact && candidate && candidate.conversationKey !== plan.existing.conversationKey) {
              return { ...plan, action: 'ignore_weak' as const, result: 'ignored_weak' as const }
            }
            if (plan.existing.conversationKey !== selected!.conversationKey) {
              return { ...plan, action: 'ignore_weak' as const, result: 'ignored_weak' as const }
            }
            if (exact && plan.existing.status === 'provisional') {
              return { ...plan, action: 'promote' as const, result: 'attached' as const }
            }
            if (plan.existing.status === 'active') {
              return { ...plan, action: 'confirm' as const, result: 'confirmed' as const }
            }
            return {
              ...plan,
              action: exact ? 'requires_supersede' as const : 'ignore_weak' as const,
              result: exact ? 'requires_supersede' as const : 'ignored_weak' as const,
            }
          }
          const activeSameKind = activeByKind.get(plan.identity.kind)
          if (activeSameKind && activeSameKind.identityValue !== plan.identity.value) {
            return {
              ...plan,
              action: exact ? 'requires_supersede' as const : 'ignore_weak' as const,
              result: exact ? 'requires_supersede' as const : 'ignored_weak' as const,
            }
          }
          return exact
            ? { ...plan, action: 'create_active' as const, result: selected!.routeVersion === 0 ? 'created' as const : 'attached' as const }
            : { ...plan, action: 'create_provisional' as const, result: 'provisional' as const }
        })
        const semanticChange = planned.some(plan =>
          plan.action === 'create_active' || plan.action === 'create_provisional' || plan.action === 'promote')
        const targetVersion = selected.routeVersion + (semanticChange ? 1 : 0)
        const routeObservationIds: string[] = []
        const results: RouteObservationResult[] = []

        for (const plan of planned) {
          if (plan.existingObservation) {
            routeObservationIds.push(plan.existingObservation.routeObservationId)
            results.push(plan.existingObservation.processingResult as RouteObservationResult)
            continue
          }
          const routeObservationId = this.#idGenerator()
          await transaction.maxRouteObservation.create({
            data: {
              routeObservationId,
              accountId: input.accountId,
              idempotencyKey: plan.idempotencyKey,
              sourceRawObservationId: input.sourceRawObservationId,
              extractorVersion: input.extractorVersion,
              observedAt: input.observedAt,
              evidenceSource: input.evidenceSource,
              evidenceAuthority: input.evidenceAuthority,
              candidateConversationKey: input.candidateConversationKey ?? selected.conversationKey,
              identityKind: plan.identity.kind,
              identityValue: plan.identity.value,
              sanitizedEvidence: sanitized.sanitizedEvidence,
              evidenceSha256: sanitized.evidenceSha256,
              evidenceSizeBytes: sanitized.evidenceSizeBytes,
              evidenceQuarantined: sanitized.evidenceQuarantined,
              redactionMetadata: sanitized.redactionMetadata,
              processingResult: plan.result,
              routeVersionAfter: targetVersion,
            },
          })
          routeObservationIds.push(routeObservationId)
          results.push(plan.result)

          if (plan.action === 'create_active' || plan.action === 'create_provisional') {
            await transaction.maxRouteIdentityBinding.create({
              data: {
                id: this.#idGenerator(),
                accountId: input.accountId,
                identityKind: plan.identity.kind,
                identityValue: plan.identity.value,
                conversationKey: selected.conversationKey,
                status: plan.action === 'create_active' ? 'active' : 'provisional',
                firstSeenAt: input.observedAt,
                lastSeenAt: input.observedAt,
                evidenceRef: routeObservationId,
                version: 0,
              },
            })
          } else if (plan.action === 'promote' || plan.action === 'confirm') {
            const update = await transaction.maxRouteIdentityBinding.updateMany({
              where: { id: plan.existing!.id, version: plan.existing!.version, accountId: input.accountId },
              data: {
                status: plan.action === 'promote' ? 'active' : plan.existing!.status,
                lastSeenAt: latestDate(plan.existing!.lastSeenAt, input.observedAt),
                evidenceRef: routeObservationId,
                version: { increment: 1 },
              },
            })
            if (update.count !== 1) throw new RouteRegistryError('STALE_ROUTE_VERSION', 'Identity changed during observation')
          }
        }

        if (semanticChange) {
          const activeProtocol = planned.some(plan =>
            plan.identity.kind === 'protocol_chat_id'
            && (plan.action === 'create_active' || plan.action === 'promote' || plan.existing?.status === 'active'))
            || activeForConversation.some(record => record.identityKind === 'protocol_chat_id')
          selected = await bumpConversation(transaction, selected, activeProtocol ? 'active' : 'unresolved')
        }
        const snapshot = await loadSnapshot(transaction, input.accountId, selected.conversationKey)
        if (!snapshot) throw new RouteRegistryError('NOT_FOUND', 'Route was not found after observation')
        return deepFreeze({
          accountId: input.accountId,
          conversationKey: selected.conversationKey,
          routeVersion: snapshot.routeVersion,
          state: snapshot.state,
          routeObservationIds,
          processingResults: results,
          idempotent: false,
          semanticChange,
        })
      })
    } catch (error) {
      throw asRouteDatabaseError(error)
    }
  }

  async #createConflicts(
    transaction: RouteRegistryPrismaTransaction,
    input: ObserveRouteEvidenceInput,
    plans: readonly ObservationPlan[],
    bindingKeys: readonly string[],
    explicitCandidateKey: string | undefined,
    sanitized: ReturnType<typeof sanitizeRouteEvidence>,
  ): Promise<ObserveRouteEvidenceResult> {
    const primaryIncumbentKey = bindingKeys[0]!
    const primary = await transaction.maxRouteConversation.findUnique({
      where: conversationKey(input.accountId, primaryIncumbentKey),
    })
    if (!primary) throw new RouteRegistryError('NOT_FOUND', 'Conflicting route was not found')
    const targetVersion = primary.routeVersion + 1
    const observationIds: string[] = []
    const results: RouteObservationResult[] = []
    for (const plan of plans) {
      if (plan.existingObservation) {
        observationIds.push(plan.existingObservation.routeObservationId)
        results.push(plan.existingObservation.processingResult as RouteObservationResult)
        continue
      }
      const id = this.#idGenerator()
      await transaction.maxRouteObservation.create({
        data: {
          routeObservationId: id,
          accountId: input.accountId,
          idempotencyKey: plan.idempotencyKey,
          sourceRawObservationId: input.sourceRawObservationId,
          extractorVersion: input.extractorVersion,
          observedAt: input.observedAt,
          evidenceSource: input.evidenceSource,
          evidenceAuthority: input.evidenceAuthority,
          candidateConversationKey: explicitCandidateKey,
          identityKind: plan.identity.kind,
          identityValue: plan.identity.value,
          sanitizedEvidence: sanitized.sanitizedEvidence,
          evidenceSha256: sanitized.evidenceSha256,
          evidenceSizeBytes: sanitized.evidenceSizeBytes,
          evidenceQuarantined: sanitized.evidenceQuarantined,
          redactionMetadata: sanitized.redactionMetadata,
          processingResult: 'conflict',
          routeVersionAfter: targetVersion,
        },
      })
      observationIds.push(id)
      results.push('conflict')
    }

    const anchorPlan = plans.find(plan => plan.existing?.conversationKey === primaryIncumbentKey) ?? plans[0]!
    const conflictPlans: Array<{
      incumbentKey: string
      candidateKey: string
      identityPlan: ObservationPlan
      sourceObservationId: string
    }> = []
    if (explicitCandidateKey) {
      for (const incumbentKey of bindingKeys.filter(key => key !== explicitCandidateKey)) {
        const planIndex = plans.findIndex(plan => plan.existing?.conversationKey === incumbentKey)
        if (planIndex < 0) continue
        conflictPlans.push({
          incumbentKey,
          candidateKey: explicitCandidateKey,
          identityPlan: plans[planIndex]!,
          sourceObservationId: observationIds[planIndex]!,
        })
      }
    } else {
      for (const candidateKey of bindingKeys.filter(key => key !== primaryIncumbentKey)) {
        const sourceIndex = plans.findIndex(plan => plan.existing?.conversationKey === candidateKey)
        if (sourceIndex < 0) continue
        conflictPlans.push({
          incumbentKey: primaryIncumbentKey,
          candidateKey,
          identityPlan: anchorPlan,
          sourceObservationId: observationIds[sourceIndex]!,
        })
      }
    }
    if (conflictPlans.length === 0) {
      throw new RouteRegistryError('IDENTITY_CONFLICT', 'Ambiguous exact evidence has no safe conflict projection')
    }

    const conflictIds: string[] = []
    const bindingsToBlock = new Map<string, IdentityRecord>()
    const routeKeysToBlock = new Set<string>()
    let createdConflict = false
    for (const plan of conflictPlans) {
      routeKeysToBlock.add(plan.incumbentKey)
      routeKeysToBlock.add(plan.candidateKey)
      const prior = await transaction.maxRouteConflict.findUnique({
        where: conflictSourceKey(input.accountId, plan.sourceObservationId),
      })
      if (prior) {
        conflictIds.push(prior.conflictId)
        continue
      }
      const incumbent = await transaction.maxRouteConversation.findUnique({
        where: conversationKey(input.accountId, plan.incumbentKey),
      })
      const candidate = await transaction.maxRouteConversation.findUnique({
        where: conversationKey(input.accountId, plan.candidateKey),
      })
      if (!incumbent || !candidate) throw new RouteRegistryError('NOT_FOUND', 'Conflicting route was not found')
      const conflictId = this.#idGenerator()
      await transaction.maxRouteConflict.create({
        data: {
          conflictId,
          accountId: input.accountId,
          identityKind: plan.identityPlan.identity.kind,
          identityValue: plan.identityPlan.identity.value,
          incumbentConversationKey: plan.incumbentKey,
          candidateConversationKey: plan.candidateKey,
          sourceRouteObservationId: plan.sourceObservationId,
          status: 'open',
          expectedRouteVersion: incumbent.routeVersion + 1,
          version: 0,
        },
      })
      conflictIds.push(conflictId)
      createdConflict = true
      if (plan.identityPlan.existing) bindingsToBlock.set(plan.identityPlan.existing.id, plan.identityPlan.existing)
    }

    if (createdConflict) {
      for (const binding of bindingsToBlock.values()) {
        if (binding.status === 'conflicted') continue
        const changed = await transaction.maxRouteIdentityBinding.updateMany({
          where: { id: binding.id, accountId: input.accountId, version: binding.version },
          data: { status: 'conflicted', version: { increment: 1 } },
        })
        if (changed.count !== 1) throw new RouteRegistryError('STALE_ROUTE_VERSION', 'Identity changed during conflict creation')
      }
      for (const key of routeKeysToBlock) {
        const route = await transaction.maxRouteConversation.findUnique({ where: conversationKey(input.accountId, key) })
        if (!route) throw new RouteRegistryError('NOT_FOUND', 'Conflicting route was not found')
        await bumpConversation(transaction, route, 'conflicted')
      }
    }
    const incumbent = await transaction.maxRouteConversation.findUnique({
      where: conversationKey(input.accountId, primaryIncumbentKey),
    })
    if (!incumbent) throw new RouteRegistryError('NOT_FOUND', 'Conflicting route was not found')
    return deepFreeze({
      accountId: input.accountId,
      conversationKey: primaryIncumbentKey,
      routeVersion: incumbent.routeVersion,
      state: 'conflicted',
      routeObservationIds: observationIds,
      processingResults: results,
      conflictId: conflictIds[0],
      idempotent: !createdConflict,
      semanticChange: createdConflict,
    })
  }

  async getRouteSnapshot(accountId: string, key: string): Promise<RouteSnapshot | null> {
    required(accountId, 'accountId', 128)
    required(key, 'conversationKey')
    try {
      return await loadSnapshot(this.#client, accountId, key)
    } catch (error) {
      throw asRouteDatabaseError(error)
    }
  }

  async getSendableRouteSnapshot(accountId: string, key: string): Promise<SendableRouteSnapshot> {
    const snapshot = await this.getRouteSnapshot(accountId, key)
    if (!snapshot) throw new RouteRegistryError('NOT_FOUND', 'Route was not found')
    const active = snapshot.identities.filter(identity => identity.status === 'active')
    const duplicateKind = active.some((identity, index) =>
      active.findIndex(candidate => candidate.kind === identity.kind) !== index)
    if (snapshot.state !== 'active'
      || snapshot.hasOpenConflict
      || duplicateKind
      || !snapshot.activeProtocolChatId) {
      throw new RouteRegistryError('ROUTE_NOT_SENDABLE', 'Route lacks one unambiguous exact protocol identity')
    }
    return snapshot as SendableRouteSnapshot
  }

  async resolveByIdentity(accountId: string, kind: RouteIdentityKind, value: string): Promise<RouteSnapshot | null> {
    required(accountId, 'accountId', 128)
    identityKind(kind)
    required(value, 'identityValue', MAX_EXACT_VALUE_LENGTH)
    try {
      const binding = await this.#client.maxRouteIdentityBinding.findUnique({ where: identityKey(accountId, kind, value) })
      if (!binding || binding.status === 'superseded') return null
      return await loadSnapshot(this.#client, accountId, binding.conversationKey)
    } catch (error) {
      throw asRouteDatabaseError(error)
    }
  }

  async listOpenConflicts(accountId: string, cursor: string | undefined, limit: number): Promise<ConflictPage> {
    required(accountId, 'accountId', 128)
    if (cursor !== undefined) required(cursor, 'cursor')
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new RouteRegistryError('INVALID_INPUT', `limit must be between 1 and ${MAX_LIST_LIMIT}`)
    }
    try {
      const records = await this.#client.maxRouteConflict.findMany({
        where: { accountId, status: 'open', ...(cursor ? { conflictId: { gt: cursor } } : {}) },
        orderBy: { conflictId: 'asc' },
        take: limit,
      })
      return deepFreeze({
        conflicts: records.map(mapConflict),
        nextCursor: records.length === limit ? records.at(-1)?.conflictId : undefined,
      })
    } catch (error) {
      throw asRouteDatabaseError(error)
    }
  }

  async supersedeIdentity(input: SupersedeIdentityInput): Promise<RouteSnapshot> {
    required(input.accountId, 'accountId', 128)
    required(input.conversationKey, 'conversationKey')
    identityKind(input.identityKind)
    required(input.oldIdentityValue, 'oldIdentityValue', MAX_EXACT_VALUE_LENGTH)
    required(input.newIdentityValue, 'newIdentityValue', MAX_EXACT_VALUE_LENGTH)
    required(input.sourceEvidenceKey, 'sourceEvidenceKey', MAX_EXACT_VALUE_LENGTH)
    required(input.actor, 'actor', 128)
    required(input.reason, 'reason', MAX_EXACT_VALUE_LENGTH)
    validDate(input.observedAt, 'observedAt')
    nonNegativeInteger(input.expectedRouteVersion, 'expectedRouteVersion')
    if (input.oldIdentityValue === input.newIdentityValue) {
      throw new RouteRegistryError('INVALID_INPUT', 'Supersede identities must differ')
    }
    const sanitized = sanitizeRouteEvidence({
      actor: input.actor,
      reason: input.reason,
      evidence: input.evidence,
    }, this.#maxEvidenceBytes)
    try {
      return await this.#client.$transaction(async transaction => {
        let conversation = await transaction.maxRouteConversation.findUnique({
          where: conversationKey(input.accountId, input.conversationKey),
        })
        if (!conversation) throw new RouteRegistryError('NOT_FOUND', 'Route was not found in account')
        if (conversation.routeVersion !== input.expectedRouteVersion) {
          throw new RouteRegistryError('STALE_ROUTE_VERSION', 'Route version conflict')
        }
        if (conversation.state === 'conflicted') throw new RouteRegistryError('OPEN_CONFLICT', 'Open conflict requires explicit resolution')
        if (conversation.state === 'retired') throw new RouteRegistryError('ROUTE_NOT_SENDABLE', 'Retired route cannot be superseded')
        const oldBinding = await transaction.maxRouteIdentityBinding.findUnique({
          where: identityKey(input.accountId, input.identityKind, input.oldIdentityValue),
        })
        if (!oldBinding || oldBinding.conversationKey !== input.conversationKey || oldBinding.status !== 'active') {
          throw new RouteRegistryError('NOT_FOUND', 'Active incumbent identity was not found')
        }
        const newBinding = await transaction.maxRouteIdentityBinding.findUnique({
          where: identityKey(input.accountId, input.identityKind, input.newIdentityValue),
        })
        if (newBinding && newBinding.conversationKey !== input.conversationKey) {
          throw new RouteRegistryError('IDENTITY_CONFLICT', 'Replacement identity belongs to another route')
        }
        const key = manualIdempotencyKey(input.sourceEvidenceKey, 'supersede', input.identityKind, input.newIdentityValue)
        const existingObservation = await transaction.maxRouteObservation.findUnique({ where: observationKey(input.accountId, key) })
        if (existingObservation) {
          const snapshot = await loadSnapshot(transaction, input.accountId, input.conversationKey)
          if (!snapshot) throw new RouteRegistryError('NOT_FOUND', 'Route was not found after idempotent supersede')
          return snapshot
        }
        const routeObservationId = this.#idGenerator()
        await transaction.maxRouteObservation.create({
          data: {
            routeObservationId,
            accountId: input.accountId,
            idempotencyKey: key,
            extractorVersion: 'manual-route-operation-v1',
            observedAt: input.observedAt,
            evidenceSource: `manual:${input.actor}`,
            evidenceAuthority: 'manual_approved',
            candidateConversationKey: input.conversationKey,
            identityKind: input.identityKind,
            identityValue: input.newIdentityValue,
            sanitizedEvidence: sanitized.sanitizedEvidence,
            evidenceSha256: sanitized.evidenceSha256,
            evidenceSizeBytes: sanitized.evidenceSizeBytes,
            evidenceQuarantined: sanitized.evidenceQuarantined,
            redactionMetadata: sanitized.redactionMetadata,
            processingResult: 'superseded',
            routeVersionAfter: conversation.routeVersion + 1,
          },
        })
        const oldUpdate = await transaction.maxRouteIdentityBinding.updateMany({
          where: { id: oldBinding.id, accountId: input.accountId, version: oldBinding.version, status: 'active' },
          data: {
            status: 'superseded',
            lastSeenAt: latestDate(oldBinding.lastSeenAt, input.observedAt),
            version: { increment: 1 },
          },
        })
        if (oldUpdate.count !== 1) throw new RouteRegistryError('STALE_ROUTE_VERSION', 'Incumbent identity changed')
        if (newBinding) {
          const newUpdate = await transaction.maxRouteIdentityBinding.updateMany({
            where: { id: newBinding.id, accountId: input.accountId, version: newBinding.version },
            data: {
              status: 'active',
              lastSeenAt: latestDate(newBinding.lastSeenAt, input.observedAt),
              evidenceRef: routeObservationId,
              version: { increment: 1 },
            },
          })
          if (newUpdate.count !== 1) throw new RouteRegistryError('STALE_ROUTE_VERSION', 'Replacement identity changed')
        } else {
          await transaction.maxRouteIdentityBinding.create({
            data: {
              id: this.#idGenerator(),
              accountId: input.accountId,
              identityKind: input.identityKind,
              identityValue: input.newIdentityValue,
              conversationKey: input.conversationKey,
              status: 'active',
              firstSeenAt: input.observedAt,
              lastSeenAt: input.observedAt,
              evidenceRef: routeObservationId,
              version: 0,
            },
          })
        }
        conversation = await bumpConversation(transaction, conversation, routeState(conversation.state))
        const snapshot = await loadSnapshot(transaction, input.accountId, conversation.conversationKey)
        if (!snapshot) throw new RouteRegistryError('NOT_FOUND', 'Route was not found after supersede')
        return snapshot
      })
    } catch (error) {
      throw asRouteDatabaseError(error)
    }
  }

  async resolveConflict(input: ResolveConflictInput): Promise<RouteConflict> {
    required(input.accountId, 'accountId', 128)
    required(input.conflictId, 'conflictId')
    required(input.actor, 'actor', 128)
    required(input.reason, 'reason', MAX_EXACT_VALUE_LENGTH)
    validDate(input.resolvedAt, 'resolvedAt')
    if (!['keep_incumbent', 'assign_candidate', 'dismiss'].includes(input.decision)) {
      throw new RouteRegistryError('INVALID_INPUT', 'Conflict resolution decision is not supported')
    }
    nonNegativeInteger(input.expectedConflictVersion, 'expectedConflictVersion')
    nonNegativeInteger(input.expectedIncumbentRouteVersion, 'expectedIncumbentRouteVersion')
    nonNegativeInteger(input.expectedCandidateRouteVersion, 'expectedCandidateRouteVersion')
    const audit = sanitizeRouteEvidence(input.auditMetadata ?? {}, this.#maxEvidenceBytes)
    try {
      return await this.#client.$transaction(async transaction => {
        const conflict = await transaction.maxRouteConflict.findUnique({ where: { conflictId: input.conflictId } })
        if (!conflict) throw new RouteRegistryError('NOT_FOUND', 'Conflict was not found')
        if (conflict.accountId !== input.accountId) throw new RouteRegistryError('ACCOUNT_MISMATCH', 'Conflict belongs to another account')
        if (conflict.status !== 'open') throw new RouteRegistryError('OPEN_CONFLICT', 'Conflict is already closed')
        if (conflict.version !== input.expectedConflictVersion) {
          throw new RouteRegistryError('STALE_CONFLICT_VERSION', 'Conflict version changed')
        }
        let incumbent = await transaction.maxRouteConversation.findUnique({
          where: conversationKey(input.accountId, conflict.incumbentConversationKey),
        })
        let candidate = await transaction.maxRouteConversation.findUnique({
          where: conversationKey(input.accountId, conflict.candidateConversationKey),
        })
        if (!incumbent || !candidate) throw new RouteRegistryError('NOT_FOUND', 'Conflict route was not found')
        if (incumbent.routeVersion !== input.expectedIncumbentRouteVersion
          || candidate.routeVersion !== input.expectedCandidateRouteVersion) {
          throw new RouteRegistryError('STALE_ROUTE_VERSION', 'Route version changed before conflict resolution')
        }
        const binding = await transaction.maxRouteIdentityBinding.findUnique({
          where: identityKey(input.accountId, identityKind(conflict.identityKind), conflict.identityValue),
        })
        if (!binding) throw new RouteRegistryError('NOT_FOUND', 'Conflicted identity was not found')

        if (input.decision === 'assign_candidate') {
          const activeCandidateKind = await transaction.maxRouteIdentityBinding.findMany({
            where: {
              accountId: input.accountId,
              conversationKey: candidate.conversationKey,
              identityKind: conflict.identityKind,
              status: 'active',
            },
          })
          if (activeCandidateKind.some(item => item.identityValue !== conflict.identityValue)) {
            throw new RouteRegistryError('IDENTITY_CONFLICT', 'Candidate already has another active identity of this kind')
          }
          const moved = await transaction.maxRouteIdentityBinding.updateMany({
            where: { id: binding.id, accountId: input.accountId, version: binding.version },
            data: {
              conversationKey: candidate.conversationKey,
              status: 'active',
              evidenceRef: conflict.sourceRouteObservationId,
              version: { increment: 1 },
            },
          })
          if (moved.count !== 1) throw new RouteRegistryError('STALE_ROUTE_VERSION', 'Conflicted identity changed')
        } else if (binding.conversationKey === incumbent.conversationKey && binding.status === 'conflicted') {
          const restored = await transaction.maxRouteIdentityBinding.updateMany({
            where: { id: binding.id, accountId: input.accountId, version: binding.version },
            data: { status: 'active', version: { increment: 1 } },
          })
          if (restored.count !== 1) throw new RouteRegistryError('STALE_ROUTE_VERSION', 'Conflicted identity changed')
        }

        const status: RouteConflictStatus = input.decision === 'dismiss' ? 'dismissed' : 'resolved'
        const closed = await transaction.maxRouteConflict.updateMany({
          where: {
            conflictId: conflict.conflictId,
            accountId: input.accountId,
            status: 'open',
            version: input.expectedConflictVersion,
          },
          data: {
            status,
            resolvedAt: input.resolvedAt,
            resolutionReason: input.reason,
            resolvedBy: input.actor,
            auditMetadata: {
              decision: input.decision,
              evidence: audit.sanitizedEvidence,
              evidenceSha256: audit.evidenceSha256,
              evidenceQuarantined: audit.evidenceQuarantined,
            },
            version: { increment: 1 },
          },
        })
        if (closed.count !== 1) throw new RouteRegistryError('STALE_CONFLICT_VERSION', 'Conflict changed during resolution')

        const sameConversation = incumbent.conversationKey === candidate.conversationKey
        incumbent = await bumpConversation(
          transaction,
          incumbent,
          await desiredState(transaction, input.accountId, incumbent.conversationKey),
        )
        if (!sameConversation) {
          candidate = await bumpConversation(
            transaction,
            candidate,
            await desiredState(transaction, input.accountId, candidate.conversationKey),
          )
        }
        const updated = await transaction.maxRouteConflict.findUnique({ where: { conflictId: conflict.conflictId } })
        if (!updated) throw new RouteRegistryError('NOT_FOUND', 'Conflict disappeared after resolution')
        return mapConflict(updated)
      })
    } catch (error) {
      throw asRouteDatabaseError(error)
    }
  }

  async retireConversation(input: RetireConversationInput): Promise<RouteSnapshot> {
    required(input.accountId, 'accountId', 128)
    required(input.conversationKey, 'conversationKey')
    required(input.sourceEvidenceKey, 'sourceEvidenceKey', MAX_EXACT_VALUE_LENGTH)
    required(input.actor, 'actor', 128)
    required(input.reason, 'reason', MAX_EXACT_VALUE_LENGTH)
    validDate(input.retiredAt, 'retiredAt')
    nonNegativeInteger(input.expectedRouteVersion, 'expectedRouteVersion')
    const sanitized = sanitizeRouteEvidence({
      actor: input.actor,
      reason: input.reason,
      evidence: input.evidence,
    }, this.#maxEvidenceBytes)
    try {
      return await this.#client.$transaction(async transaction => {
        let conversation = await transaction.maxRouteConversation.findUnique({
          where: conversationKey(input.accountId, input.conversationKey),
        })
        if (!conversation) throw new RouteRegistryError('NOT_FOUND', 'Route was not found in account')
        if (conversation.routeVersion !== input.expectedRouteVersion) {
          throw new RouteRegistryError('STALE_ROUTE_VERSION', 'Route version conflict')
        }
        if (conversation.state === 'conflicted') {
          throw new RouteRegistryError('OPEN_CONFLICT', 'Open conflict must be resolved before retirement')
        }
        const identities = await transaction.maxRouteIdentityBinding.findMany({
          where: { accountId: input.accountId, conversationKey: input.conversationKey },
          orderBy: { identityKind: 'asc' },
        })
        const identity = identities[0]
        if (!identity) throw new RouteRegistryError('NOT_FOUND', 'Route has no identity evidence')
        const kind = identityKind(identity.identityKind)
        const key = manualIdempotencyKey(input.sourceEvidenceKey, 'retire', kind, identity.identityValue)
        const existing = await transaction.maxRouteObservation.findUnique({ where: observationKey(input.accountId, key) })
        if (existing && conversation.state === 'retired') {
          const snapshot = await loadSnapshot(transaction, input.accountId, input.conversationKey)
          if (!snapshot) throw new RouteRegistryError('NOT_FOUND', 'Retired route was not found')
          return snapshot
        }
        if (conversation.state === 'retired') {
          throw new RouteRegistryError('ROUTE_NOT_SENDABLE', 'Route is already retired')
        }
        const routeObservationId = this.#idGenerator()
        await transaction.maxRouteObservation.create({
          data: {
            routeObservationId,
            accountId: input.accountId,
            idempotencyKey: key,
            extractorVersion: 'manual-route-operation-v1',
            observedAt: input.retiredAt,
            evidenceSource: `manual:${input.actor}`,
            evidenceAuthority: 'manual_approved',
            candidateConversationKey: input.conversationKey,
            identityKind: kind,
            identityValue: identity.identityValue,
            sanitizedEvidence: sanitized.sanitizedEvidence,
            evidenceSha256: sanitized.evidenceSha256,
            evidenceSizeBytes: sanitized.evidenceSizeBytes,
            evidenceQuarantined: sanitized.evidenceQuarantined,
            redactionMetadata: sanitized.redactionMetadata,
            processingResult: 'retired',
            routeVersionAfter: conversation.routeVersion + 1,
          },
        })
        conversation = await bumpConversation(transaction, conversation, 'retired', {
          retiredAt: input.retiredAt,
          retiredBy: input.actor,
          retirementReason: input.reason,
        })
        const snapshot = await loadSnapshot(transaction, input.accountId, conversation.conversationKey)
        if (!snapshot) throw new RouteRegistryError('NOT_FOUND', 'Route was not found after retirement')
        return snapshot
      })
    } catch (error) {
      throw asRouteDatabaseError(error)
    }
  }
}
