export const CONTACT_PROFILE_PARK_ORDER = [
  'Наш Автопарк',
  'YOKO',
  'YOKO-2',
  'YOKO-3',
  'YOKO-4',
  'YOKO.Доставка',
] as const

export type ContactDriverProfileState =
  | 'UNLINKED'
  | 'UNLINKED_WITH_SUGGESTIONS'
  | 'LINKED'
  | 'LINKED_WITH_ANOMALIES'

export type ContactProfileSyncStatus = 'ok' | 'stale' | 'error' | 'never'
export type DriverProfileStatus = 'working' | 'dismissed' | 'unknown'

export interface ContactPhonePayload {
  id: string
  phone: string
  label: string | null
  isPrimary: boolean
  source: string
  isTemporary?: boolean
  expiresAt?: string | null
  isActive?: boolean
}

export interface ContactIdentityPayload {
  id: string
  channel: string
  externalId: string
  phoneId: string | null
  displayName: string | null
  source: string
  confidence: number
  reachabilityStatus: 'confirmed' | 'unreachable' | 'unknown'
  reachabilityCheckedAt: string | null
  metadata?: Record<string, string | null> | null
}

export interface ContactChatPayload {
  id: string
  channel: string
  externalChatId: string
  contactIdentityId: string | null
  lastMessageAt: string | null
  unreadCount: number
  status: string
  name: string | null
}

export interface ContactChannelPayload {
  channel: 'max' | 'whatsapp' | 'telegram'
  identityId: string | null
  externalId: string | null
  displayName: string | null
  state: 'linked' | 'available_by_phone'
}

export interface CanonicalContactSummaryPayload {
  displayName: string
  primaryPhone: string | null
  displayTitle: string
  currentMainDriverProfile: {
    id: string
    fullName: string
    phone: string | null
    segment: string | null
  } | null
  currentChannel: string | null
  providerIdentities: Array<{
    channel: string
    externalId: string
    displayName: string | null
  }>
  channelCount: number
}

export interface ConflictContactPayload {
  id: string
  displayName: string
  chatId: string | null
}

export interface ContactDriverProfilePayload {
  id: string
  yandexDriverId: string
  externalDriverProfileId: string | null
  externalParkId: string | null
  fullName: string
  phone: string | null
  licenseNumber?: string | null
  lastExternalPark: string | null
  parkCode: string | null
  parkName: string
  employmentTypeCode: string | null
  employmentTypeLabel: string
  /** @deprecated Use employmentTypeCode and employmentTypeLabel. */
  employmentType: string | null
  workStatus: string | null
  currentStatus: string | null
  segment: string
  score?: number | null
  status: DriverProfileStatus
  normalizedStatus: DriverProfileStatus
  statusLabel: string
  isMain: boolean
  contactId: string | null
  conflictContactId: string | null
  conflictContact: ConflictContactPayload | null
  linkedContactConflict: boolean
  linkedContactSummary: ConflictContactPayload | null
  matchedSignals: string[]
  suggestionBasis: string
  suggestionBasisLabel: string
  personResolutionStatus: string
  personResolutionBasis: string | null
  externalPersonKey: string | null
  lastOrderAt: string | null
  hiredAt: string | null
  dismissedAt: string | null
  sourceUpdatedAt: string | null
  lastSuccessfulSyncAt: string | null
  lastFailedSyncAt: string | null
}

export interface ContactProfileAnomalyPayload {
  type:
    | 'multiple_active_profiles_same_park'
    | 'profile_belongs_to_other_contact'
    | 'different_names'
    | 'person_ownership_ambiguous'
    | 'sync_stale'
    | 'sync_error'
  severity: 'warning' | 'error'
  message: string
  parkName?: string
  profileIds: string[]
  contactId?: string
}

export interface ContactProfileSyncStatePayload {
  status: ContactProfileSyncStatus
  lastSuccessfulAt: string | null
  lastFailedAt: string | null
  error: string | null
  parks: Array<{
    parkCode: string
    parkName: string
    lastSuccessfulAt: string | null
    lastFailedAt: string | null
    error: string | null
    state?: 'fresh' | 'stale' | 'backoff' | 'never'
    retryAt?: string | null
    canRetry?: boolean
  }>
}

export interface ContactTechnicalDataPayload {
  contactId: string
  providerIds: Array<{ channel: string; externalId: string }>
  driverProfileIds: string[]
  suggestedProfileIds: string[]
  resolutionState: ContactDriverProfileState
  lastSuccessfulSyncAt: string | null
  lastFailedSyncAt: string | null
  profileSourceValues: Array<{
    id: string
    employmentTypeCode: string | null
    workStatusCode: string | null
    currentStatusCode: string | null
  }>
  syncFailures?: Array<{
    parkCode: string
    failedAt: string | null
    retryAt: string | null
    rawError: string | null
  }>
}

export type TelegramBotStateCode =
  | 'BOT_BOUND'
  | 'BOT_BOUND_WITHOUT_PROFILE'
  | 'BOT_BOUND_TO_NON_MAIN_PROFILE'
  | 'BOT_BOUND_TO_DISMISSED_PROFILE'
  | 'TELEGRAM_IDENTITY_AVAILABLE_BOT_UNBOUND'
  | 'TELEGRAM_DISCOVERED_BY_PHONE'
  | 'NO_TELEGRAM_IDENTITY'
  | 'TEMPORARILY_UNAVAILABLE'
  | 'CONFLICT'

export interface TelegramIdentityPayload {
  telegramUserId: string | null
  username: string | null
  displayName: string | null
  source: 'driver_telegram' | 'contact_identity'
  lastObservedUsername: string | null
  lastObservedAt: string | null
  lastSyncAt: string | null
  lastVerifiedAt: string | null
}

export interface TelegramBotStatePayload {
  status: TelegramBotStateCode
  linked: boolean
  telegramUserId: string | null
  username: string | null
  driverProfile: ContactDriverProfilePayload | null
  activeParkId: string | null
  parkName: string | null
  boundAt: string | null
  lastUpdatedAt: string | null
  source: 'driver_telegram' | 'contact_identity' | 'none'
  conflictCount: number
}

export interface ContactProfilePayload {
  id: string
  displayName: string
  displayNameSource: string
  masterSource: string
  yandexDriverId: string | null
  mainDriverId: string | null
  mainDriverSelection: string
  primaryPhoneId: string | null
  primaryPhone: ContactPhonePayload | null
  notes: string | null
  tags: string[]
  customFields: Record<string, unknown>
  isArchived: boolean
  createdAt: string
  updatedAt: string
  phones: ContactPhonePayload[]
  identities: ContactIdentityPayload[]
  chats: ContactChatPayload[]
  channels: ContactChannelPayload[]
  canonicalSummary?: CanonicalContactSummaryPayload
  driverProfileState: ContactDriverProfileState
  suggestedProfiles: ContactDriverProfilePayload[]
  attachedProfiles: ContactDriverProfilePayload[]
  mainDriverProfile: ContactDriverProfilePayload | null
  syncState: ContactProfileSyncStatePayload
  anomalies: ContactProfileAnomalyPayload[]
  technicalData: ContactTechnicalDataPayload
  telegramIdentity?: TelegramIdentityPayload | null
  telegramBotState?: TelegramBotStatePayload

  // Backward-compatible aliases used by older Messages components.
  driver: ContactDriverProfilePayload | null
  mainDriver: ContactDriverProfilePayload | null
  driverProfiles: ContactDriverProfilePayload[]
  profileAnomalies: Array<{ park: string; activeCount: number; driverIds: string[] }>
  suggestedDriverProfiles: ContactDriverProfilePayload[]
  mergeHistory: Array<Record<string, unknown>>
}

export function deriveDriverProfileState(
  attachedCount: number,
  suggestionCount: number,
  anomalyCount: number,
): ContactDriverProfileState {
  if (attachedCount === 0) {
    return suggestionCount > 0 ? 'UNLINKED_WITH_SUGGESTIONS' : 'UNLINKED'
  }
  return anomalyCount > 0 ? 'LINKED_WITH_ANOMALIES' : 'LINKED'
}
