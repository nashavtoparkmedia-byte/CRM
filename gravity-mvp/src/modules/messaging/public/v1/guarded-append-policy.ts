/**
 * Messaging guarded append policy (R-21). Pure: no IO.
 *
 * Decides whether one provider event may become visible in its conversation,
 * from two facts only: what the caller proved about this event's sender, and
 * the person binding the conversation carries right now. It never resolves a
 * person and never proposes a binding — Contacts owns both — so an
 * uncertainty can only ever hold an event, never attach it to somebody.
 *
 * - private, proven:   visible only when the conversation is bound to exactly
 *                      the proven contact and identity, and that binding is not
 *                      one R-22 proves is another person's (contradicted);
 * - private, unproven: visible only in a conversation bound to nobody (no
 *                      contact, no identity, no driver), where it cannot merge
 *                      into any person's conversation;
 * - group:             visible only while the group carries no person binding.
 */
import type {
  GuardedConversationKindV1,
  GuardedSenderAttributionV1,
  HeldChannelMessageReasonV1,
} from '../../../../contracts/messaging/v1'

export interface ConversationPersonBindingV1 {
  contactId: string | null
  contactIdentityId: string | null
  driverId: string | null
  /**
   * R-22 on the write side: hard evidence that this binding is another person's
   * (its linked identity belongs to another contact, or a numeric Telegram
   * identity names a different peer than the conversation key). A proof that
   * equals a contradicted binding never shows an event.
   */
  contradicted: boolean
}

export type GuardedAppendDecisionV1 =
  | { visible: true }
  | { visible: false; reason: HeldChannelMessageReasonV1 }

export function hasConversationPersonBindingV1(binding: ConversationPersonBindingV1): boolean {
  return binding.contactId !== null || binding.contactIdentityId !== null || binding.driverId !== null
}

export function decideGuardedAppendV1(
  kind: GuardedConversationKindV1,
  attribution: GuardedSenderAttributionV1,
  binding: ConversationPersonBindingV1,
): GuardedAppendDecisionV1 {
  const bound = hasConversationPersonBindingV1(binding)
  if (kind === 'group') {
    return bound ? { visible: false, reason: 'group_person_bound' } : { visible: true }
  }
  if (attribution.status === 'proven') {
    if (!binding.contradicted && binding.contactId === attribution.contactId && binding.contactIdentityId === attribution.contactIdentityId) {
      return { visible: true }
    }
    return { visible: false, reason: bound ? 'binding_mismatch' : 'binding_absent' }
  }
  if (attribution.status === 'unproven') {
    return bound ? { visible: false, reason: 'attribution_unproven' } : { visible: true }
  }
  // not_applicable is a group attribution; the contract parser never pairs it with a private conversation.
  return { visible: false, reason: bound ? 'attribution_unproven' : 'binding_absent' }
}
