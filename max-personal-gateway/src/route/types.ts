import type { JsonValue, RedactionEvidence } from '../journal/types.ts'

export type ConversationKey = string
export type RouteState = 'unresolved' | 'active' | 'conflicted' | 'retired'
export type RouteIdentityKind = 'provider_user_id' | 'protocol_chat_id' | 'web_route_id'
export type RouteIdentityStatus = 'provisional' | 'active' | 'superseded' | 'conflicted'
export type RouteConflictStatus = 'open' | 'resolved' | 'dismissed'
export type RouteEvidenceAuthority =
  | 'protocol_exact'
  | 'provider_exact'
  | 'web_route_observed'
  | 'legacy_import'
  | 'manual_approved'
export type RouteObservationResult =
  | 'created'
  | 'confirmed'
  | 'attached'
  | 'provisional'
  | 'conflict'
  | 'requires_supersede'
  | 'ignored_weak'
  | 'superseded'
  | 'retired'

export interface RouteIdentityEvidence {
  readonly kind: RouteIdentityKind
  readonly value: string
}

export interface ObserveRouteEvidenceInput {
  readonly accountId: string
  readonly sourceEvidenceKey: string
  readonly sourceRawObservationId?: string
  readonly extractorVersion: string
  readonly observedAt: Date
  readonly evidenceSource: string
  readonly evidenceAuthority: Exclude<RouteEvidenceAuthority, 'manual_approved'>
  readonly candidateConversationKey?: ConversationKey
  readonly identities: readonly RouteIdentityEvidence[]
  readonly evidence: unknown
}

export interface ObserveRouteEvidenceResult {
  readonly accountId: string
  readonly conversationKey: ConversationKey
  readonly routeVersion: number
  readonly state: RouteState
  readonly routeObservationIds: readonly string[]
  readonly processingResults: readonly RouteObservationResult[]
  readonly conflictId?: string
  readonly idempotent: boolean
  readonly semanticChange: boolean
}

export interface RouteIdentitySnapshot {
  readonly kind: RouteIdentityKind
  readonly value: string
  readonly status: RouteIdentityStatus
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly evidenceRef: string
  readonly version: number
}

export interface RouteSnapshot {
  readonly accountId: string
  readonly conversationKey: ConversationKey
  readonly routeVersion: number
  readonly state: RouteState
  readonly identities: readonly RouteIdentitySnapshot[]
  readonly activeProviderUserId?: string
  readonly activeProtocolChatId?: string
  readonly activeWebRouteId?: string
  readonly evidenceReferences: readonly string[]
  readonly hasOpenConflict: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SendableRouteSnapshot extends RouteSnapshot {
  readonly state: 'active'
  readonly activeProtocolChatId: string
}

export interface RouteConflict {
  readonly conflictId: string
  readonly accountId: string
  readonly identityKind: RouteIdentityKind
  readonly identityValue: string
  readonly incumbentConversationKey: ConversationKey
  readonly candidateConversationKey: ConversationKey
  readonly sourceRouteObservationId: string
  readonly status: RouteConflictStatus
  readonly expectedRouteVersion: number
  readonly version: number
  readonly createdAt: string
  readonly resolvedAt?: string
  readonly resolutionReason?: string
  readonly resolvedBy?: string
  readonly auditMetadata?: JsonValue
}

export interface ConflictPage {
  readonly conflicts: readonly RouteConflict[]
  readonly nextCursor?: string
}

export interface SupersedeIdentityInput {
  readonly accountId: string
  readonly conversationKey: ConversationKey
  readonly identityKind: RouteIdentityKind
  readonly oldIdentityValue: string
  readonly newIdentityValue: string
  readonly sourceEvidenceKey: string
  readonly expectedRouteVersion: number
  readonly actor: string
  readonly reason: string
  readonly observedAt: Date
  readonly evidence: unknown
}

export type ConflictResolutionDecision = 'keep_incumbent' | 'assign_candidate' | 'dismiss'

export interface ResolveConflictInput {
  readonly accountId: string
  readonly conflictId: string
  readonly decision: ConflictResolutionDecision
  readonly expectedConflictVersion: number
  readonly expectedIncumbentRouteVersion: number
  readonly expectedCandidateRouteVersion: number
  readonly actor: string
  readonly reason: string
  readonly resolvedAt: Date
  readonly auditMetadata?: unknown
}

export interface RetireConversationInput {
  readonly accountId: string
  readonly conversationKey: ConversationKey
  readonly expectedRouteVersion: number
  readonly sourceEvidenceKey: string
  readonly actor: string
  readonly reason: string
  readonly retiredAt: Date
  readonly evidence: unknown
}

export interface RouteEvidenceEnvelope {
  readonly sanitizedEvidence: JsonValue
  readonly evidenceSha256: string
  readonly evidenceSizeBytes: number
  readonly evidenceQuarantined: boolean
  readonly redactionMetadata: RedactionEvidence
}
