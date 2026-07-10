import type {
  ContactResolutionInput,
  ContactResolutionResult,
  ResolutionWarning,
} from './contact-resolution.types'

export type MaxShadowEventSource = 'live' | 'history' | 'replay' | 'unknown'

export type LegacyContactResolutionOutcome =
  | {
      status: 'contact_reused'
      contactId: string
      source: 'identity' | 'phone' | 'existing_chat' | 'driver' | 'unknown'
    }
  | { status: 'contact_created'; contactId: string }
  | { status: 'no_contact'; reason: string }
  | { status: 'legacy_error'; errorCode: string }

export type ContactResolutionComparisonStatus =
  | 'agreement_existing_contact'
  | 'agreement_new_contact'
  | 'planner_more_cautious'
  | 'legacy_more_cautious'
  | 'contact_mismatch'
  | 'identity_phone_conflict_ignored_by_legacy'
  | 'ambiguous_phone_ignored_by_legacy'
  | 'archived_contact_used_by_legacy'
  | 'merge_cycle_detected'
  | 'not_comparable'
  | 'planner_error'
  | 'legacy_error'

export interface ContactResolutionComparison {
  comparisonStatus: ContactResolutionComparisonStatus
  plannerCanonicalContactId?: string
  legacyContactId?: string
}

export interface MaxContactResolutionShadowInput {
  resolutionInput: ContactResolutionInput
  isOutgoing: boolean | null | undefined
  eventSource: MaxShadowEventSource
}

export type MaxShadowSkipReason =
  | 'disabled'
  | 'outgoing_or_unknown_direction'
  | 'group_or_unknown_chat_kind'
  | 'missing_sender_identity'

export interface MaxContactResolutionShadowLog {
  channel: 'max'
  comparisonStatus: ContactResolutionComparisonStatus
  plannerStatus: ContactResolutionResult['status'] | 'planner_error'
  legacyStatus: LegacyContactResolutionOutcome['status']
  plannerCanonicalContactId?: string
  legacyContactId?: string
  warnings: ResolutionWarning[]
  eventSource: MaxShadowEventSource
  providerAccountScopeAvailable: false
  plannerDurationMs: number
  totalShadowDurationMs: number
  durationMs: number
  errorCode?: string
}

export interface ContactResolutionPlanner {
  resolve(input: ContactResolutionInput): Promise<ContactResolutionResult>
}

export interface MaxContactResolutionShadowDependencies {
  enabled: boolean
  planner: ContactResolutionPlanner
  compare(
    shadowPlan: ContactResolutionResult,
    legacyOutcome: LegacyContactResolutionOutcome,
  ): ContactResolutionComparison
  log(record: MaxContactResolutionShadowLog): void
  now(): number
  plannerTimeoutMs: number
}

export interface MaxContactResolutionShadowSession {
  complete(outcome: LegacyContactResolutionOutcome): Promise<void>
}

export interface MaxContactResolutionShadowStart {
  session: MaxContactResolutionShadowSession | null
  skipReason?: MaxShadowSkipReason
}
