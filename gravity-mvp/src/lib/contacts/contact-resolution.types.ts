export type ContactResolutionChannel = 'max' | 'telegram' | 'whatsapp' | 'phone' | 'avito'

export type PhoneEvidenceSource =
  | 'provider_profile'
  | 'whatsapp_phone_jid'
  | 'shared_contact'
  | 'manual_verified'
  | 'yandex'
  | 'message_text'
  | 'unknown'

export type ResolutionWarning =
  | 'provider_account_scope_not_persisted'
  | 'global_identity_key'
  | 'global_chat_key'
  | 'global_message_key'
  | 'phone_verification_model_limited'
  | 'phone_lifecycle_ineligible'
  | 'phone_trust_ineligible'
  | 'phone_stale'
  | 'phone_shared'
  | 'phone_disputed'
  | 'phone_not_trusted_for_automatic_resolution'
  | 'invalid_normalized_phone'
  | 'merge_depth_exceeded'

export interface ContactResolutionInput {
  channel: ContactResolutionChannel
  externalUserId?: string | null
  externalChatId?: string | null
  providerAccountId?: string | null
  channelDisplayName?: string | null
  username?: string | null
  normalizedPhone?: string | null
  phoneEvidence?: {
    source: PhoneEvidenceSource
    trustedForAutomaticResolution: boolean
  } | null
  chatKind?: 'private' | 'group' | 'unknown'
}

export interface ResolutionContact {
  id: string
  isArchived: boolean
}

export interface ResolutionPhoneClaim {
  contact: ResolutionContact
  lifecycle: 'current' | 'superseded' | 'removed' | 'unknown'
  trust: 'provider_bound' | 'manually_verified' | 'source_asserted' | 'claimed' | 'unknown'
  freshness: 'fresh' | 'stale' | 'unknown'
  resolutionState: 'unique' | 'shared' | 'disputed' | 'unknown'
}

export interface ContactMergeEdge {
  mergedId: string
  survivor: ResolutionContact
}

/**
 * Deliberately small read-only boundary. Stage 3A must never receive a
 * Prisma client directly in resolution code that can mutate CRM records.
 */
export interface ContactResolutionRepository {
  findIdentity(
    channel: ContactResolutionChannel,
    providerAccountId: string,
    externalUserId: string,
  ): Promise<ResolutionContact | null>
  findActivePhoneClaims(normalizedPhone: string): Promise<ResolutionPhoneClaim[]>
  findMergesFromContact(contactId: string): Promise<ContactMergeEdge[]>
}

export type ContactResolutionResult =
  | {
      status: 'identity_found'
      contactId: string
      canonicalContactId: string
      warnings: ResolutionWarning[]
    }
  | {
      status: 'phone_matched'
      contactId: string
      canonicalContactId: string
      warnings: ResolutionWarning[]
    }
  | { status: 'create_required'; warnings: ResolutionWarning[] }
  | {
      status: 'ambiguous_phone'
      candidateContactIds: string[]
      warnings: ResolutionWarning[]
    }
  | {
      status: 'identity_phone_conflict'
      identityContactId: string
      phoneContactIds: string[]
      warnings: ResolutionWarning[]
    }
  | {
      status: 'merged_contact'
      originalContactId: string
      canonicalContactId: string
      warnings: ResolutionWarning[]
    }
  | {
      status: 'archived_without_merge'
      contactId: string
      warnings: ResolutionWarning[]
    }
  | { status: 'skipped_group'; warnings: ResolutionWarning[] }
  | { status: 'unknown_kind_limited'; warnings: ResolutionWarning[] }
  | { status: 'untrusted_phone'; warnings: ResolutionWarning[] }
  | { status: 'ineligible_phone'; warnings: ResolutionWarning[] }
  | { status: 'invalid_input'; warnings: ResolutionWarning[] }
  | {
      status: 'merge_cycle'
      contactIds: string[]
      warnings: ResolutionWarning[]
    }
  | {
      status: 'merge_ambiguous'
      contactIds: string[]
      warnings: ResolutionWarning[]
    }
  | {
      status: 'merge_depth_exceeded'
      contactIds: string[]
      warnings: ResolutionWarning[]
    }
