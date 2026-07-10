import { ContactResolutionService } from './ContactResolutionService'
import type { ContactResolutionResult } from './contact-resolution.types'
import type {
  ContactResolutionComparison,
  ContactResolutionComparisonStatus,
  ContactResolutionPlanner,
  LegacyContactResolutionOutcome,
  MaxContactResolutionShadowDependencies,
  MaxContactResolutionShadowInput,
  MaxContactResolutionShadowLog,
  MaxContactResolutionShadowSession,
  MaxContactResolutionShadowStart,
  MaxShadowSkipReason,
} from './contact-resolution-shadow.types'

const DEFAULT_PLANNER_TIMEOUT_MS = 1_500

function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error && typeof error.name === 'string') {
    return error.name.slice(0, 80)
  }
  return 'unknown_shadow_error'
}

function canonicalContactId(plan: ContactResolutionResult): string | undefined {
  switch (plan.status) {
    case 'identity_found':
    case 'phone_matched':
    case 'merged_contact':
      return plan.canonicalContactId
    default:
      return undefined
  }
}

function legacyContactId(outcome: LegacyContactResolutionOutcome): string | undefined {
  return outcome.status === 'contact_reused' || outcome.status === 'contact_created'
    ? outcome.contactId
    : undefined
}

export function isMaxContactResolutionShadowEnabled(value = process.env.CONTACT_RESOLUTION_SHADOW_MAX): boolean {
  if (!value) return false
  return value.trim().toLowerCase() === 'true' || value.trim() === '1'
}

export function maxContactResolutionShadowSkipReason(
  input: MaxContactResolutionShadowInput,
  enabled: boolean,
): MaxShadowSkipReason | null {
  if (!enabled) return 'disabled'
  if (input.isOutgoing !== false) return 'outgoing_or_unknown_direction'
  if (input.resolutionInput.chatKind !== 'private') return 'group_or_unknown_chat_kind'
  if (!input.resolutionInput.externalUserId?.trim()) return 'missing_sender_identity'
  return null
}

/** Pure comparison: no Prisma access and no writes. */
export function compareContactResolution(
  shadowPlan: ContactResolutionResult,
  legacyOutcome: LegacyContactResolutionOutcome,
): ContactResolutionComparison {
  const plannerCanonicalContactId = canonicalContactId(shadowPlan)
  const legacyId = legacyContactId(legacyOutcome)
  const base = { plannerCanonicalContactId, legacyContactId: legacyId }

  if (legacyOutcome.status === 'legacy_error') {
    return { comparisonStatus: 'legacy_error', ...base }
  }
  if (shadowPlan.status === 'merge_cycle') {
    return { comparisonStatus: 'merge_cycle_detected', ...base }
  }
  if (shadowPlan.status === 'archived_without_merge' && legacyOutcome.status === 'contact_reused') {
    return { comparisonStatus: 'archived_contact_used_by_legacy', ...base }
  }
  if (shadowPlan.status === 'identity_phone_conflict' && legacyOutcome.status === 'contact_reused') {
    return { comparisonStatus: 'identity_phone_conflict_ignored_by_legacy', ...base }
  }
  if (shadowPlan.status === 'ambiguous_phone' && legacyOutcome.status === 'contact_reused') {
    return { comparisonStatus: 'ambiguous_phone_ignored_by_legacy', ...base }
  }
  if (
    shadowPlan.status === 'ambiguous_phone'
    || shadowPlan.status === 'identity_phone_conflict'
    || shadowPlan.status === 'archived_without_merge'
    || shadowPlan.status === 'merge_ambiguous'
    || shadowPlan.status === 'merge_depth_exceeded'
  ) {
    return { comparisonStatus: 'planner_more_cautious', ...base }
  }
  if (shadowPlan.status === 'create_required' && legacyOutcome.status === 'contact_created') {
    return { comparisonStatus: 'agreement_new_contact', ...base }
  }
  if (
    shadowPlan.status === 'skipped_group'
    || shadowPlan.status === 'untrusted_phone'
    || shadowPlan.status === 'invalid_input'
  ) {
    return { comparisonStatus: 'not_comparable', ...base }
  }
  if (plannerCanonicalContactId) {
    if (legacyOutcome.status === 'contact_reused') {
      return plannerCanonicalContactId === legacyOutcome.contactId
        ? { comparisonStatus: 'agreement_existing_contact', ...base }
        : { comparisonStatus: 'contact_mismatch', ...base }
    }
    if (legacyOutcome.status === 'contact_created' || legacyOutcome.status === 'no_contact') {
      return { comparisonStatus: 'legacy_more_cautious', ...base }
    }
  }
  return { comparisonStatus: 'not_comparable', ...base }
}

function defaultDependencies(): MaxContactResolutionShadowDependencies {
  return {
    enabled: isMaxContactResolutionShadowEnabled(),
    planner: ContactResolutionService.fromPrisma(),
    compare: compareContactResolution,
    log(record) {
      console.info('[CONTACT_RESOLUTION_SHADOW]', JSON.stringify(record))
    },
    now: () => Date.now(),
    plannerTimeoutMs: DEFAULT_PLANNER_TIMEOUT_MS,
  }
}

async function resolveWithinTimeout(
  planner: ContactResolutionPlanner,
  input: MaxContactResolutionShadowInput['resolutionInput'],
  timeoutMs: number,
): Promise<ContactResolutionResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const plannerPromise = planner.resolve(input)
  // The race may finish first. Consume a late rejection from the underlying
  // read-only query so it cannot become an unhandled promise rejection.
  plannerPromise.catch(() => undefined)
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('contact_resolution_shadow_timeout')
      error.name = 'ContactResolutionShadowTimeout'
      reject(error)
    }, timeoutMs)
  })

  try {
    return await Promise.race([plannerPromise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function startMaxContactResolutionShadow(
  input: MaxContactResolutionShadowInput,
  overrides: Partial<MaxContactResolutionShadowDependencies> = {},
): Promise<MaxContactResolutionShadowStart> {
  const defaults = defaultDependencies()
  const dependencies: MaxContactResolutionShadowDependencies = { ...defaults, ...overrides }
  const skipReason = maxContactResolutionShadowSkipReason(input, dependencies.enabled)
  if (skipReason) return { session: null, skipReason }

  const totalStartedAt = dependencies.now()
  let shadowPlan: ContactResolutionResult | null = null
  let plannerErrorCode: string | undefined
  let plannerDurationMs = 0

  try {
    const plannerStartedAt = dependencies.now()
    shadowPlan = await resolveWithinTimeout(
      dependencies.planner,
      input.resolutionInput,
      dependencies.plannerTimeoutMs,
    )
    plannerDurationMs = dependencies.now() - plannerStartedAt
  } catch (error) {
    plannerDurationMs = dependencies.now() - totalStartedAt
    plannerErrorCode = safeErrorCode(error)
  }

  const session: MaxContactResolutionShadowSession = {
    async complete(legacyOutcome) {
      let comparisonStatus: ContactResolutionComparisonStatus = 'planner_error'
      let comparison: ContactResolutionComparison | null = null
      let errorCode = plannerErrorCode

      try {
        if (shadowPlan) {
          comparison = dependencies.compare(shadowPlan, legacyOutcome)
          comparisonStatus = comparison.comparisonStatus
        }
      } catch (error) {
        errorCode = safeErrorCode(error)
      }

      const totalShadowDurationMs = dependencies.now() - totalStartedAt
      const record: MaxContactResolutionShadowLog = {
        channel: 'max',
        comparisonStatus,
        plannerStatus: shadowPlan?.status ?? 'planner_error',
        legacyStatus: legacyOutcome.status,
        ...(comparison?.plannerCanonicalContactId ? { plannerCanonicalContactId: comparison.plannerCanonicalContactId } : {}),
        ...(comparison?.legacyContactId ? { legacyContactId: comparison.legacyContactId } : {}),
        warnings: shadowPlan?.warnings ?? [],
        eventSource: input.eventSource,
        providerAccountScopeAvailable: false,
        plannerDurationMs,
        totalShadowDurationMs,
        durationMs: totalShadowDurationMs,
        ...(errorCode ? { errorCode } : {}),
      }

      try {
        dependencies.log(record)
      } catch (error) {
        console.error('[CONTACT_RESOLUTION_SHADOW] logger_error', safeErrorCode(error))
      }
    },
  }

  return { session }
}
