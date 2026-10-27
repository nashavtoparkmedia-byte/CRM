import type { ContactCommunicationPermissionResultV1 } from '../../../contracts/contacts/v1/contact-communication-policy-contracts'
import {
    SEND_TO_CONTACT_CHANNELS_V1,
    SEND_TO_CONTACT_RESULT_V1,
    type SendToContactAdmittedV1,
    type SendToContactChannelV1,
    type SendToContactFailureClassV1,
    type SendToContactRefusalReasonV1,
    type SendToContactRefusedV1,
    type SendToContactResultV1,
} from '../../../contracts/messaging/v1/send-to-contact-command'
import { deriveDeliveryStateV1, readChannelDeliveryErrorV1 } from '../public/v1/delivery-state-policy'
import { prepareSendToContactRequestV1 } from './send-to-contact-request'
import {
    classifySendToContactRouteProofFailureV1,
    discoverSendToContactRouteV1,
    type SendToContactRouteDiscoveryPortsV1,
    type SendToContactRouteRefusalV1,
} from './send-to-contact-routing'

/** The one Message an intent admitted, as Messaging persisted it. */
export interface SendToContactMessageRowV1 {
    id: string
    channel: string | null
    direction: string | null
    status: string | null
    metadata: unknown
}

export interface SendToContactPortsV1 extends SendToContactRouteDiscoveryPortsV1 {
    /** Insert-if-absent of (requestId, sha), then the sha the requestId is bound to. Throws when the store is unavailable. */
    claimIntent(requestId: string, semanticPayloadSha256: string): Promise<string>
    findAdmittedMessage(clientMessageId: string): Promise<SendToContactMessageRowV1 | null>
    /** Contacts' contacts.ContactCommunicationPermissionQuery.v1 for the `message` class (P1). */
    readContactPermission(contactId: string): Promise<ContactCommunicationPermissionResultV1>
    /**
     * The shared send engine: proves the route again, applies the authoritative
     * gate (P2) and admits at most one Message under clientMessageId. Throws
     * when it refuses before a Message exists. `replayed` is true when a concurrent
     * request of this same intent admitted the Message first.
     */
    admit(input: {
        conversationId: string
        content: string
        clientMessageId: string
        expectedCanonicalContactId: string
    }): Promise<{ replayed: boolean }>
}

type Refusal = Pick<SendToContactRefusedV1, 'reason' | 'retryable' | 'detail' | 'identityStatus' | 'candidateChannels'>

function refused(requestId: string, refusal: Refusal): SendToContactRefusedV1 {
    return { contract: SEND_TO_CONTACT_RESULT_V1, outcome: 'refused', requestId, ...refusal }
}

const unavailable = (reason: SendToContactRefusalReasonV1, retryable: boolean): Refusal => ({ reason, retryable })

/**
 * Contacts' answer, in SendToContact's words. Which denials stand is Contacts'
 * ruling (`retryable`); only the name of a standing one is chosen here.
 */
export function sendToContactPermissionRefusalV1(reason: string, retryable: boolean): Refusal {
    if (retryable) return unavailable('permission_unavailable', true)
    if (reason === 'contact_unknown') return unavailable('contact_unknown', false)
    if (reason === 'contact_archived') return unavailable('contact_archived', false)
    if (reason.startsWith('restricted_')) return unavailable('contact_restricted', false)
    return unavailable('permission_unavailable', false)
}

/** P1: the canonical Contact a send may be evaluated for, or why there is none. */
function readPermission(result: unknown): { canonicalContactId: string } | { refusal: Refusal } {
    const answer = result && typeof result === 'object' ? result as Partial<ContactCommunicationPermissionResultV1> : {}
    if (answer.decision === 'allow') {
        return typeof answer.canonicalContactId === 'string' && answer.canonicalContactId !== ''
            ? { canonicalContactId: answer.canonicalContactId }
            : { refusal: unavailable('permission_unavailable', true) }
    }
    if (answer.decision === 'deny' && typeof answer.reason === 'string' && typeof answer.retryable === 'boolean') {
        return { refusal: sendToContactPermissionRefusalV1(answer.reason, answer.retryable) }
    }
    return { refusal: unavailable('permission_unavailable', true) }
}

/** Why the engine refused before any Message existed. */
function engineRefusal(error: unknown): Refusal {
    const typed = readChannelDeliveryErrorV1(error)
    if (typed?.code === 'MESSAGING_CONTACT_PERMISSION_REFUSED') {
        const reason = (error as Error).message.split(':')[1] ?? ''
        return sendToContactPermissionRefusalV1(reason, false)
    }
    if (typed?.code === 'MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED') return unavailable('permission_unavailable', true)
    if (error instanceof Error && error.message === 'MESSAGING_SEND_TO_CONTACT_LINEAGE_MOVED') {
        return { reason: 'route_evidence_incomplete', retryable: true, detail: 'lineage_moved' }
    }
    // The route changed between discovery and the send: the same closed proof refusals.
    const proof = classifySendToContactRouteProofFailureV1(error)
    if (proof) return { reason: 'route_unavailable', retryable: false, ...proof }
    return unavailable('messaging_unavailable', true)
}

function failureClass(row: SendToContactMessageRowV1, state: string): SendToContactFailureClassV1 | undefined {
    if (state === 'failed_safe_to_retry') return 'not_dispatched'
    if (state === 'indeterminate') return 'outcome_unknown'
    if (state !== 'failed_not_safe_to_retry') return undefined
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : {}
    return metadata.errorCode === 'MESSAGING_CONTACT_PERMISSION_REFUSED' ? 'permission_refused' : 'provider_refused'
}

/** The Message's state now; null when the row is not a SendToContact send Messaging can describe. */
function admitted(requestId: string, row: SendToContactMessageRowV1, replayed: boolean): SendToContactAdmittedV1 | null {
    const state = deriveDeliveryStateV1(row)
    const channel = row.channel
    if (!state || !channel || !(SEND_TO_CONTACT_CHANNELS_V1 as readonly string[]).includes(channel)) return null
    const failure = failureClass(row, state)
    return {
        contract: SEND_TO_CONTACT_RESULT_V1,
        outcome: 'admitted',
        requestId,
        replayed,
        messageId: row.id,
        channel: channel as SendToContactChannelV1,
        deliveryState: state,
        ...(failure ? { failureClass: failure } : {}),
    }
}

/**
 * messaging.SendToContactCommand.v1 → messaging.SendToContactResult.v1.
 *
 *   parse → fingerprint → claim the requestId → another payload ⇒ idempotency_conflict
 *         → its Message exists ⇒ replay (state read now; no permission or route read)
 *         → P1 Contacts permission (precise early refusal, canonical Contact)
 *         → route discovery (proof only; exactly one route)
 *         → engine: route proof again, P2 authoritative gate, one Message, provider, settle
 *
 * A malformed or unsupported command throws SendToContactValidationError and
 * claims nothing. A refusal creates no Message and no provider effect; an
 * admitted Message is Messaging's to deliver and redeliver, never the caller's.
 */
export function createSendToContactHandlerV1(ports: SendToContactPortsV1) {
    return async function sendToContactV1(input: unknown): Promise<SendToContactResultV1> {
        const { command, semanticPayloadSha256, clientMessageId } = prepareSendToContactRequestV1(input)
        const { requestId } = command

        let bound: string
        try {
            bound = await ports.claimIntent(requestId, semanticPayloadSha256)
        } catch {
            return refused(requestId, unavailable('messaging_unavailable', true))
        }
        if (bound !== semanticPayloadSha256) {
            return { contract: SEND_TO_CONTACT_RESULT_V1, outcome: 'idempotency_conflict', requestId }
        }

        const replay = async (replayed: boolean): Promise<SendToContactResultV1 | null> => {
            const row = await ports.findAdmittedMessage(clientMessageId)
            if (!row) return null
            return admitted(requestId, row, replayed) ?? refused(requestId, unavailable('messaging_unavailable', true))
        }

        try {
            const earlier = await replay(true)
            if (earlier) return earlier
        } catch {
            return refused(requestId, unavailable('messaging_unavailable', true))
        }

        let permission: ReturnType<typeof readPermission>
        try {
            permission = readPermission(await ports.readContactPermission(command.contactId))
        } catch {
            permission = { refusal: unavailable('permission_unavailable', true) }
        }
        if ('refusal' in permission) return refused(requestId, permission.refusal)

        const route = await discoverSendToContactRouteV1({
            contactId: command.contactId,
            expectedCanonicalContactId: permission.canonicalContactId,
            ...(command.allowedChannels ? { allowedChannels: command.allowedChannels } : {}),
        }, ports)
        if (route.kind === 'refused') return refused(requestId, route.refusal as SendToContactRouteRefusalV1)

        let failure: unknown = null
        let replayed = false
        try {
            ({ replayed } = await ports.admit({
                conversationId: route.conversationId,
                content: command.content,
                clientMessageId,
                expectedCanonicalContactId: permission.canonicalContactId,
            }))
        } catch (error: unknown) {
            failure = error
        }
        // Whatever the engine answered, the Message is the truth: a concurrent
        // request of this same intent may have admitted it, and a failure after
        // admission leaves a row Messaging now owns.
        try {
            const result = await replay(replayed)
            if (result) return result
        } catch {
            return refused(requestId, unavailable('messaging_unavailable', true))
        }
        return refused(requestId, failure === null ? unavailable('messaging_unavailable', true) : engineRefusal(failure))
    }
}
