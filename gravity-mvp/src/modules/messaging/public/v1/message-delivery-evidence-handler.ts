import {
    PATCH_MESSAGE_DELIVERY_RESULT_V2,
    parsePatchMessageDeliveryCommandV2,
    type MessageDeliveryEvidenceV2,
    type PatchMessageDeliveryCommandV2,
    type PatchMessageDeliveryResultV2,
} from '../../../../contracts/messaging/v1'
import {
    deliveryEvidenceRankV1,
    deliveryEvidenceSourceV1,
    newDeliveryEvidenceRecordV1,
    provenDeliveryRankV1,
    statusForDeliveryEvidenceV1,
} from './delivery-state-policy'

/** The persisted fields the evidence command decides on. */
export interface DeliveryEvidenceRowV1 {
    id: string
    chatId: string
    direction: string
    channel: string | null
    type: string
    content: string
    status: string
    externalId: string | null
    metadata: unknown
    sentAt: Date
    updatedAt: Date
}

export interface DeliveryEvidenceWriteV1 {
    status: 'sent' | 'delivered' | 'read'
    externalId?: string
    metadata: Record<string, unknown>
}

export interface MessageDeliveryEvidencePortV1 {
    findByProviderId(providerMessageId: string): Promise<DeliveryEvidenceRowV1 | null>
    /** Outbound text rows of one conversation with this exact text and no provider id, sent within the window; oldest first. */
    findUnsettledByContent(input: { chatId: string; channel: string; content: string; sentFrom: Date; sentTo: Date }): Promise<DeliveryEvidenceRowV1[]>
    /** Compare-and-set on the row version: 'stale' when the row changed since it was read, 'provider_id_taken' when another row owns the id. */
    apply(row: DeliveryEvidenceRowV1, write: DeliveryEvidenceWriteV1): Promise<'applied' | 'stale' | 'provider_id_taken'>
    /** Runs after a promotion: broadcast, and the outbound workflow once when the row leaves a failure. */
    afterApplied(input: { messageId: string; chatId: string; promotedFromFailure: boolean; at: Date }): Promise<void>
    now(): Date
}

// How far before providerSentAt an unsettled CRM send can still be the
// message the provider reports.
const UNSETTLED_MATCH_WINDOW_MS = 10 * 60_000
// Provider timestamps are whole seconds and host clocks drift, so a CRM row
// can carry a sentAt slightly after the provider's own time for that message.
const PROVIDER_CLOCK_TOLERANCE_MS = 60_000
const APPLY_ATTEMPTS = 3

// The provider has no such signal for this kind of account: a Telegram user
// account never reports that a recipient's device received a message.
const PROVIDER_UNSUPPORTED: Readonly<Record<string, readonly MessageDeliveryEvidenceV2[]>> = {
    telegram: ['device_receipt'],
}

// What a failed row carried about its failure; a promotion clears all of it.
const FAILURE_FIELDS = ['error', 'errorCode', 'errorSchemaVersion', 'retryable', 'deliveryOutcome', 'lastFailedAt', 'providerIdConflict']

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * A CRM send the provider has not answered for yet: still in flight or
 * awaiting proof (send_requested), or of unknown outcome (indeterminate).
 * A failure proven safe to redeliver or refused is never a candidate; nor is a
 * row that already holds a provider id.
 */
function isUnsettledCandidate(row: DeliveryEvidenceRowV1, command: PatchMessageDeliveryCommandV2): boolean {
    if (row.chatId !== command.chatId || row.channel !== command.channel || row.direction !== 'outbound') return false
    if (row.type !== 'text' || row.content !== command.content || row.externalId) return false
    if (row.status === 'failed') return record(row.metadata).deliveryOutcome === 'unknown'
    return row.status === 'sent' && provenDeliveryRankV1(row) < 1
}

function result(
    outcome: PatchMessageDeliveryResultV2['outcome'],
    match: { messageId: string; matchedBy: 'provider_id' | 'unresolved_content' } | null,
    reason: PatchMessageDeliveryResultV2['reason'] = null,
): PatchMessageDeliveryResultV2 {
    return {
        contract: PATCH_MESSAGE_DELIVERY_RESULT_V2,
        outcome,
        messageId: match?.messageId ?? null,
        matchedBy: match?.matchedBy ?? null,
        reason,
    }
}

/**
 * The one way late delivery evidence reaches a Message (S2): an own-message
 * echo, a history read-back, a provider ack or a receipt.
 *
 * Resolution, in order: the row holding this exact provider id (refused when
 * that row is not this conversation's outbound message on this channel); else
 * the oldest unsettled CRM send in the conversation with the same text; else
 * no_match, and the caller records the message as it does today.
 *
 * Application is monotonic: evidence is applied only when stronger than what
 * the row already proves, so a repeat, an out-of-order receipt or stale
 * evidence leaves it unchanged. A row it promotes out of a failure loses the
 * failure record. An in-flight retry's lease is revoked, so that attempt's
 * answer can never overwrite the proof.
 */
export function createApplyMessageDeliveryEvidenceHandlerV1(port: MessageDeliveryEvidencePortV1) {
    return async function applyMessageDeliveryEvidenceV1(command: PatchMessageDeliveryCommandV2 | unknown): Promise<PatchMessageDeliveryResultV2> {
        const parsed = parsePatchMessageDeliveryCommandV2(command)
        if (PROVIDER_UNSUPPORTED[parsed.channel]?.includes(parsed.evidence)) return result('refused', null, 'provider_unsupported')
        const evidenceRank = deliveryEvidenceRankV1(parsed.evidence)

        for (let attempt = 1; attempt <= APPLY_ATTEMPTS; attempt++) {
            let row = await port.findByProviderId(parsed.providerMessageId)
            let matchedBy: 'provider_id' | 'unresolved_content' = 'provider_id'
            if (row) {
                if (row.chatId !== parsed.chatId || row.channel !== parsed.channel || row.direction !== 'outbound') {
                    return result('refused', null, 'provider_id_collision')
                }
            } else if (parsed.content !== undefined) {
                const reference = parsed.providerSentAt ?? port.now()
                const candidates = await port.findUnsettledByContent({
                    chatId: parsed.chatId,
                    channel: parsed.channel,
                    content: parsed.content,
                    sentFrom: new Date(reference.getTime() - UNSETTLED_MATCH_WINDOW_MS),
                    sentTo: new Date(reference.getTime() + PROVIDER_CLOCK_TOLERANCE_MS),
                })
                row = candidates.find(candidate => isUnsettledCandidate(candidate, parsed)) ?? null
                matchedBy = 'unresolved_content'
            }
            if (!row) return result('no_match', null)
            const match = { messageId: row.id, matchedBy }

            if (evidenceRank <= provenDeliveryRankV1(row)) return result('unchanged', match)

            const at = port.now()
            const promotedFromFailure = row.status === 'failed'
            const metadata = { ...record(row.metadata) }
            delete metadata.retryLeaseId
            if (promotedFromFailure) for (const field of FAILURE_FIELDS) delete metadata[field]
            metadata.delivery = newDeliveryEvidenceRecordV1(parsed.evidence, deliveryEvidenceSourceV1(parsed.evidence), at)
            const applied = await port.apply(row, {
                status: statusForDeliveryEvidenceV1(parsed.evidence),
                ...(row.externalId ? {} : { externalId: parsed.providerMessageId }),
                metadata,
            })
            if (applied === 'provider_id_taken') return result('refused', match, 'provider_id_collision')
            if (applied === 'applied') {
                await port.afterApplied({ messageId: row.id, chatId: row.chatId, promotedFromFailure, at })
                return result('applied', match)
            }
            // The row changed under us (its own send settled, other evidence
            // landed): resolve again from the start against the new state.
        }
        return result('refused', null, 'contention')
    }
}
