/**
 * Messaging delivery evidence policy (S2). Pure: no IO, no framework, safe to
 * import from the server and from client components alike.
 *
 * A message's delivery state is derived from what was PROVEN about it — the
 * row's status, its recorded failure outcome and its delivery evidence — never
 * from whether a provider id happens to be stored, and never from a UI action.
 * Server answers, history reads and the conversation view all derive it here,
 * so they cannot disagree.
 *
 * Evidence only strengthens:
 *   client_action < provider_ack = provider_echo = history_readback
 *                 < device_receipt < read_receipt
 */

import type { ChannelDeliveryErrorV1, TextDeliveryResultV1 } from './channel-delivery-runtime'

export type DeliveryEvidenceKindV1 =
    | 'client_action'
    | 'provider_ack'
    | 'provider_echo'
    | 'history_readback'
    | 'device_receipt'
    | 'read_receipt'

/** Where the evidence was observed: the send itself, a provider echo, a provider ack or receipt, a history read-back. */
export type DeliveryEvidenceSourceV1 = 'send' | 'echo' | 'ack' | 'sync'

/** Written only by Messaging into `Message.metadata.delivery`. */
export interface DeliveryEvidenceRecordV1 {
    v: 1
    evidence: DeliveryEvidenceKindV1
    evidenceAt: string
    source: DeliveryEvidenceSourceV1
}

export type DeliveryStateV1 =
    | 'send_requested'
    | 'provider_accepted'
    | 'delivered'
    | 'read'
    | 'failed_safe_to_retry'
    | 'failed_not_safe_to_retry'
    | 'indeterminate'

export interface DeliveryStateInputV1 {
    direction?: string | null
    status?: string | null
    metadata?: unknown
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Strength of one kind of evidence; -1 when the value is not evidence at all. */
export function deliveryEvidenceRankV1(evidence: unknown): number {
    switch (evidence) {
        case 'client_action': return 0
        case 'provider_ack':
        case 'provider_echo':
        case 'history_readback': return 1
        case 'device_receipt': return 2
        case 'read_receipt': return 3
        default: return -1
    }
}

export function isDeliveryEvidenceKindV1(value: unknown): value is DeliveryEvidenceKindV1 {
    return deliveryEvidenceRankV1(value) >= 0
}

/** The provider has this exact message: provider_ack or anything stronger. */
export function isProviderAcceptedEvidenceV1(evidence: unknown): boolean {
    return deliveryEvidenceRankV1(evidence) >= 1
}

/** The row status a piece of evidence supports. A client action supports no more than `sent`. */
export function statusForDeliveryEvidenceV1(evidence: DeliveryEvidenceKindV1): 'sent' | 'delivered' | 'read' {
    const rank = deliveryEvidenceRankV1(evidence)
    return rank >= 3 ? 'read' : rank === 2 ? 'delivered' : 'sent'
}

/** The source a piece of evidence naturally comes from, when the caller does not say. */
export function deliveryEvidenceSourceV1(evidence: DeliveryEvidenceKindV1): DeliveryEvidenceSourceV1 {
    if (evidence === 'provider_echo') return 'echo'
    if (evidence === 'history_readback') return 'sync'
    if (evidence === 'client_action') return 'send'
    return 'ack'
}

export function newDeliveryEvidenceRecordV1(
    evidence: DeliveryEvidenceKindV1,
    source: DeliveryEvidenceSourceV1,
    at: Date,
): DeliveryEvidenceRecordV1 {
    return { v: 1, evidence, evidenceAt: at.toISOString(), source }
}

/** The recorded delivery evidence of a row, or null for a row written before S2. */
export function readDeliveryEvidenceV1(metadata: unknown): DeliveryEvidenceRecordV1 | null {
    const delivery = record(record(metadata).delivery)
    if (delivery.v !== 1 || !isDeliveryEvidenceKindV1(delivery.evidence)) return null
    return {
        v: 1,
        evidence: delivery.evidence,
        evidenceAt: typeof delivery.evidenceAt === 'string' ? delivery.evidenceAt : '',
        source: delivery.source === 'echo' || delivery.source === 'ack' || delivery.source === 'sync' ? delivery.source : 'send',
    }
}

/**
 * The strength of what a row currently proves about delivery, so late evidence
 * is applied only when it is stronger: -1 when it proves nothing. A failed row
 * proves nothing, whatever an earlier record says. A row written before S2
 * carries no evidence record; its status is then the best statement of what it
 * claims.
 */
export function provenDeliveryRankV1(row: DeliveryStateInputV1): number {
    if (row.status === 'failed') return -1
    const recorded = readDeliveryEvidenceV1(row.metadata)
    const byStatus = row.status === 'read' ? 3 : row.status === 'delivered' ? 2 : -1
    return Math.max(recorded ? deliveryEvidenceRankV1(recorded.evidence) : -1, byStatus)
}

/**
 * The one delivery state of an outbound message; null for anything else.
 *
 * - failed: unknown outcome → indeterminate; a failure the current taxonomy
 *   (error schema v2+) proved safe to redeliver → failed_safe_to_retry; every
 *   other failure → failed_not_safe_to_retry.
 * - read / delivered: as the row says (receipt evidence, or a row written
 *   before S2 that is shown as it always was).
 * - otherwise: provider_accepted only with provider_ack or stronger evidence;
 *   a client action, or no evidence at all, is send_requested.
 */
export function deriveDeliveryStateV1(row: DeliveryStateInputV1): DeliveryStateV1 | null {
    if (row.direction !== 'outbound') return null
    const metadata = record(row.metadata)
    if (row.status === 'failed') {
        if (metadata.deliveryOutcome === 'unknown') return 'indeterminate'
        const safe = metadata.retryable === true
            && metadata.deliveryOutcome === 'safe_to_redeliver'
            && typeof metadata.errorSchemaVersion === 'number'
            && metadata.errorSchemaVersion >= 2
        return safe ? 'failed_safe_to_retry' : 'failed_not_safe_to_retry'
    }
    if (row.status === 'read') return 'read'
    if (row.status === 'delivered') return 'delivered'
    const recorded = readDeliveryEvidenceV1(metadata)
    return recorded && isProviderAcceptedEvidenceV1(recorded.evidence) ? 'provider_accepted' : 'send_requested'
}

export function isDeliveryStateV1(value: unknown): value is DeliveryStateV1 {
    switch (value) {
        case 'send_requested':
        case 'provider_accepted':
        case 'delivered':
        case 'read':
        case 'failed_safe_to_retry':
        case 'failed_not_safe_to_retry':
        case 'indeterminate': return true
        default: return false
    }
}

/** The operator-facing label of a delivery state. */
export function deliveryStateLabelV1(state: DeliveryStateV1): string {
    switch (state) {
        case 'send_requested': return 'Ожидает подтверждения'
        case 'provider_accepted': return 'Отправлено'
        case 'delivered': return 'Доставлено'
        case 'read': return 'Прочитано'
        case 'indeterminate': return 'Статус доставки неизвестен'
        case 'failed_safe_to_retry':
        case 'failed_not_safe_to_retry': return 'Не отправлено'
    }
}

// ── Reading what an adapter returned or threw ───────────────────────────

/** The proven outcome of a typed adapter failure, or null for any other error. */
export function readChannelDeliveryErrorV1(error: unknown): { outcome: ChannelDeliveryErrorV1['deliveryOutcome']; code: string | null } | null {
    if (!(error instanceof Error) || error.name !== 'ChannelDeliveryErrorV1') return null
    const { deliveryOutcome, deliveryErrorCode } = error as Partial<ChannelDeliveryErrorV1>
    if (deliveryOutcome !== 'safe_to_redeliver' && deliveryOutcome !== 'terminal') return null
    return { outcome: deliveryOutcome, code: typeof deliveryErrorCode === 'string' && deliveryErrorCode.trim() !== '' ? deliveryErrorCode : null }
}

/**
 * The typed reading of an adapter's send result, or null for a legacy result.
 * A provider_ack or provider_echo that names no provider id proves nothing
 * about this message and is read as a client_action.
 */
export function readTextDeliveryResultV1(result: unknown): TextDeliveryResultV1 | null {
    if (!result || typeof result !== 'object') return null
    const { evidence, providerMessageId, resolvedChatId } = result as Partial<Record<keyof TextDeliveryResultV1, unknown>>
    if (evidence !== 'client_action' && evidence !== 'provider_ack' && evidence !== 'provider_echo') return null
    const id = typeof providerMessageId === 'string' && providerMessageId.trim() !== '' ? providerMessageId : null
    return {
        evidence: evidence !== 'client_action' && id === null ? 'client_action' : evidence,
        providerMessageId: id,
        ...(typeof resolvedChatId === 'string' && resolvedChatId.trim() !== '' ? { resolvedChatId } : {}),
    }
}
