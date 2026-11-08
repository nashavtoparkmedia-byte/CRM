/**
 * The effects boundary of Communication Workspace. Every provider-facing effect
 * passes here, and here the sandbox allowlist is enforced a second time (the
 * service enforces it first): an effect for a Contact outside a sandbox Run's
 * allowlist is refused before any port is called, whatever the caller passed.
 *
 * - simulated: deterministic, recorded once per effect request id in the Run's
 *   own audit trail, and never reaching any provider. This is the only effects
 *   mode unless COMMUNICATION_WORKSPACE_EFFECTS is exactly "live".
 * - live: messages through Messaging's SendToContact (permanent requestId
 *   identity, at most one provider effect). Calling has no public "call this
 *   Contact" contract yet, so a live call answers `unavailable`; reply evidence
 *   is not yet integrated, so it answers null and the Flow never calls without it.
 */
import type { SendToContactResultV1 } from '../../../contracts/messaging/v1/send-to-contact-command'
import type { CallEffectResultV1, MessageEffectResultV1 } from '../application/communication-policy'
import type {
  CommunicationEffectsV1,
  CommunicationStorePortV1,
  EffectRunContextV1,
} from '../application/communication-run-service'

export function effectPermittedBySandboxV1(run: EffectRunContextV1, contactId: string): boolean {
  if (run.mode !== 'sandbox') return true
  return run.sandboxAllowlist.includes(run.requestedContactId) || run.sandboxAllowlist.includes(contactId)
}

export type CommunicationEffectsModeV1 = 'simulated' | 'live'

/** Live effects only on the exact opt-in; anything else, including unset, is simulated. */
export function communicationEffectsModeV1(env: Record<string, string | undefined>): CommunicationEffectsModeV1 {
  return env.COMMUNICATION_WORKSPACE_EFFECTS === 'live' ? 'live' : 'simulated'
}

export function createSimulatedCommunicationEffectsV1(store: CommunicationStorePortV1, clock: () => Date): CommunicationEffectsV1 {
  async function recordOnce(run: EffectRunContextV1, requestId: string, effect: 'message' | 'call', outcome: string): Promise<string> {
    const dedupeKey = `sim:${requestId}`
    await store.appendEvent({
      id: `sim-${requestId}`,
      runId: run.runId,
      participantId: run.participantId,
      dedupeKey,
      kind: 'simulated_provider_effect',
      detail: { effect, requestId, outcome, note: 'Simulated: nothing was sent to any provider' },
      occurredAt: clock(),
    })
    // Whoever recorded first decides: a repeated or concurrent request gets the same outcome.
    const recorded = await store.findEvent(dedupeKey)
    return String(recorded?.detail.outcome ?? outcome)
  }

  return {
    mode: 'simulated',
    message: {
      async send({ requestId, contactId, run }): Promise<MessageEffectResultV1> {
        if (!effectPermittedBySandboxV1(run, contactId)) return { kind: 'sandbox_blocked' }
        const outcome = await recordOnce(run, requestId, 'message', run.simulated?.message ?? 'accepted')
        if (outcome === 'refused') return { kind: 'refused', reason: 'provider_refused', retryable: false }
        if (outcome === 'indeterminate') return { kind: 'indeterminate' }
        return { kind: 'accepted', deliveryState: null }
      },
    },
    call: {
      async call({ requestId, contactId, run }): Promise<CallEffectResultV1> {
        if (!effectPermittedBySandboxV1(run, contactId)) return { kind: 'sandbox_blocked' }
        const outcome = await recordOnce(run, requestId, 'call', run.simulated?.call ?? 'answered')
        if (outcome === 'no_answer' || outcome === 'failed' || outcome === 'indeterminate') return { kind: outcome }
        return { kind: 'answered' }
      },
    },
    reply: {
      async hasReplySince({ participantId }) {
        return (await store.findEvent(`sim-reply:${participantId}`)) !== null
      },
    },
  }
}

/** SendToContact's answer, read onto the Flow's effect vocabulary. */
export function messageEffectFromSendToContactV1(result: SendToContactResultV1): MessageEffectResultV1 {
  if (result.outcome === 'idempotency_conflict') return { kind: 'refused', reason: 'idempotency_conflict', retryable: false }
  if (result.outcome === 'refused') return { kind: 'refused', reason: result.reason, retryable: result.retryable }
  if (result.failureClass === 'outcome_unknown') return { kind: 'indeterminate' }
  if (result.failureClass) return { kind: 'refused', reason: result.failureClass, retryable: false }
  return { kind: 'accepted', deliveryState: result.deliveryState }
}

export function createLiveCommunicationEffectsV1(deps: {
  sendToContact: (command: unknown) => Promise<SendToContactResultV1>
}): CommunicationEffectsV1 {
  return {
    mode: 'live',
    message: {
      async send({ requestId, contactId, text, run }): Promise<MessageEffectResultV1> {
        if (!effectPermittedBySandboxV1(run, contactId)) return { kind: 'sandbox_blocked' }
        try {
          return messageEffectFromSendToContactV1(await deps.sendToContact({
            contract: 'messaging.SendToContactCommand.v1',
            requestId,
            contactId,
            content: text,
          }))
        } catch {
          return { kind: 'indeterminate' }
        }
      },
    },
    call: {
      async call({ contactId, run }): Promise<CallEffectResultV1> {
        if (!effectPermittedBySandboxV1(run, contactId)) return { kind: 'sandbox_blocked' }
        return { kind: 'unavailable' }
      },
    },
    reply: {
      async hasReplySince() {
        return null
      },
    },
  }
}
