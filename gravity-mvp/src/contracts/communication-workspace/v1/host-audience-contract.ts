/**
 * communication-workspace.HostAudienceSubmission.v1 — the standard host
 * integration contract ("plug and socket").
 *
 * A business host module (Отток first, later Документы and others) says WHO
 * and WHY: the canonical Contacts its own trigger selected, the reason each one
 * was selected, a reference to the host's source record and an immutable
 * business context. Communication Workspace decides WHAT to do with them.
 *
 * The host never passes a chat, conversation, identity, phone, provider,
 * account, transport or route: Contacts and Messaging own those. The host's
 * snapshot reference names ONE evaluation of its trigger; submitting the same
 * reference again is the same audience, never a second one.
 */

export const HOST_AUDIENCE_SUBMISSION_V1 = 'communication-workspace.HostAudienceSubmission.v1' as const
export const HOST_AUDIENCE_MAX_MEMBERS_V1 = 5000
const ID_MAX = 255
const KEY_MAX = 128
const REF_MAX = 200
const REASON_MAX = 500
const CONTEXT_KEYS_MAX = 24
const CONTEXT_TEXT_MAX = 300

export type HostBusinessValueV1 = string | number | boolean | null

export interface HostAudienceMemberV1 {
  /** A Contacts canonical (or merged-away) Contact id. Contacts resolves lineage. */
  contactId: string
  /** Human-readable reason the host's trigger selected this Contact. */
  reason: string
  /** The host's own source record (for Отток: the driver profile). */
  sourceRef: string
  /** Immutable facts the decision was made on, as the host evaluated them. */
  businessContext: Record<string, HostBusinessValueV1>
}

export interface HostAudienceSubmissionV1 {
  contract: typeof HOST_AUDIENCE_SUBMISSION_V1
  /** The host module, e.g. 'churn'. */
  hostModule: string
  /** The host's trigger, e.g. 'fleet.churn.no_orders_days'. */
  triggerKey: string
  triggerVersion: number
  /** One evaluation of the trigger; the same reference is the same snapshot. */
  snapshotRef: string
  /** When the host evaluated its trigger (ISO 8601). */
  evaluatedAt: string
  /** The trigger's parameters as evaluated, e.g. { minInactiveDays: 5 }. */
  criteria: Record<string, HostBusinessValueV1>
  members: HostAudienceMemberV1[]
}

export class HostAudienceContractErrorV1 extends Error {
  constructor(message: string) {
    super(`COMMUNICATION_HOST_AUDIENCE_INVALID: ${message}`)
    this.name = 'HostAudienceContractErrorV1'
  }
}

function invalid(message: string): never {
  throw new HostAudienceContractErrorV1(message)
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be an object`)
  return value as Record<string, unknown>
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`${field}.${key} is not part of the contract`)
  }
}

function boundedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`)
  if (value.trim() !== value || value.length === 0) invalid(`${field} must be a non-empty string without surrounding whitespace`)
  if (value.length > maxLength) invalid(`${field} must be at most ${maxLength} characters`)
  if (/[\u0000-\u001F\u007F]/u.test(value)) invalid(`${field} must not contain control characters`)
  return value
}

function key(value: unknown, field: string): string {
  const text = boundedText(value, field, KEY_MAX)
  if (!/^[a-z][a-z0-9._-]*$/u.test(text)) invalid(`${field} must be a lower-case key`)
  return text
}

function businessContext(value: unknown, field: string): Record<string, HostBusinessValueV1> {
  const object = record(value, field)
  const entries = Object.entries(object)
  if (entries.length > CONTEXT_KEYS_MAX) invalid(`${field} has more than ${CONTEXT_KEYS_MAX} keys`)
  const out: Record<string, HostBusinessValueV1> = {}
  for (const [name, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name)) invalid(`${field}.${name} is not a valid key`)
    if (item === null || typeof item === 'boolean') out[name] = item
    else if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid(`${field}.${name} must be finite`)
      out[name] = item
    } else if (typeof item === 'string') {
      if (item.length > CONTEXT_TEXT_MAX) invalid(`${field}.${name} must be at most ${CONTEXT_TEXT_MAX} characters`)
      out[name] = item
    } else invalid(`${field}.${name} must be a string, number, boolean or null`)
  }
  return out
}

/**
 * Strict structural parse. A malformed submission is refused as a whole;
 * nothing is admitted from it. Duplicate Contacts inside one submission are
 * kept as given here: admission records the duplicate, the parser does not
 * silently drop people.
 */
export function parseHostAudienceSubmissionV1(input: unknown): HostAudienceSubmissionV1 {
  const value = record(input, 'submission')
  if (value.contract !== HOST_AUDIENCE_SUBMISSION_V1) invalid(`contract must be ${HOST_AUDIENCE_SUBMISSION_V1}`)
  exactFields(value, ['contract', 'hostModule', 'triggerKey', 'triggerVersion', 'snapshotRef', 'evaluatedAt', 'criteria', 'members'], 'submission')
  const triggerVersion = value.triggerVersion
  if (typeof triggerVersion !== 'number' || !Number.isSafeInteger(triggerVersion) || triggerVersion < 1) invalid('triggerVersion must be a positive integer')
  const evaluatedAt = boundedText(value.evaluatedAt, 'evaluatedAt', 40)
  if (Number.isNaN(Date.parse(evaluatedAt))) invalid('evaluatedAt must be an ISO 8601 time')
  if (!Array.isArray(value.members)) invalid('members must be an array')
  if (value.members.length > HOST_AUDIENCE_MAX_MEMBERS_V1) invalid(`members must be at most ${HOST_AUDIENCE_MAX_MEMBERS_V1}`)
  const members = value.members.map((raw, index): HostAudienceMemberV1 => {
    const member = record(raw, `members[${index}]`)
    exactFields(member, ['contactId', 'reason', 'sourceRef', 'businessContext'], `members[${index}]`)
    return {
      contactId: boundedText(member.contactId, `members[${index}].contactId`, ID_MAX),
      reason: boundedText(member.reason, `members[${index}].reason`, REASON_MAX),
      sourceRef: boundedText(member.sourceRef, `members[${index}].sourceRef`, REF_MAX),
      businessContext: businessContext(member.businessContext, `members[${index}].businessContext`),
    }
  })
  return {
    contract: HOST_AUDIENCE_SUBMISSION_V1,
    hostModule: key(value.hostModule, 'hostModule'),
    triggerKey: key(value.triggerKey, 'triggerKey'),
    triggerVersion,
    snapshotRef: boundedText(value.snapshotRef, 'snapshotRef', REF_MAX),
    evaluatedAt: new Date(evaluatedAt).toISOString(),
    criteria: businessContext(value.criteria, 'criteria'),
    members,
  }
}
