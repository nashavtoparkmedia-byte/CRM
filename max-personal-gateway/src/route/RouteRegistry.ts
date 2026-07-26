import type {
  ConflictPage,
  ObserveRouteEvidenceInput,
  ObserveRouteEvidenceResult,
  ResolveConflictInput,
  RetireConversationInput,
  RouteConflict,
  RouteIdentityKind,
  RouteSnapshot,
  SendableRouteSnapshot,
  SupersedeIdentityInput,
} from './types.ts'

export interface RouteRegistry {
  observeRouteEvidence(input: ObserveRouteEvidenceInput): Promise<ObserveRouteEvidenceResult>
  getRouteSnapshot(accountId: string, conversationKey: string): Promise<RouteSnapshot | null>
  getSendableRouteSnapshot(accountId: string, conversationKey: string): Promise<SendableRouteSnapshot>
  resolveByIdentity(accountId: string, identityKind: RouteIdentityKind, identityValue: string): Promise<RouteSnapshot | null>
  listOpenConflicts(accountId: string, cursor: string | undefined, limit: number): Promise<ConflictPage>
  supersedeIdentity(input: SupersedeIdentityInput): Promise<RouteSnapshot>
  resolveConflict(input: ResolveConflictInput): Promise<RouteConflict>
  retireConversation(input: RetireConversationInput): Promise<RouteSnapshot>
}
