import type {
    ContactConversationsEntryV1,
    ContactConversationsFoundV1,
} from '../../../contracts/messaging/v1/contact-conversations-query'
import {
    SEND_TO_CONTACT_CHANNELS_V1,
    type SendToContactChannelV1,
    type SendToContactRefusedV1,
    type SendToContactRouteEvidenceIncompleteDetailV1,
    type SendToContactRouteUnavailableDetailV1,
} from '../../../contracts/messaging/v1/send-to-contact-command'

/**
 * SendToContact route discovery: which ONE existing conversation of the
 * Contact a send may use. Deterministic and without ranking — exactly one
 * provable route is selected, anything else is refused. It performs no write
 * and no send; both reads are injected.
 *
 *   eligible = request allowedChannels ∩ sendable channels ∩ conversations whose route proof holds
 *
 * Discovery never authorizes a send. The selected conversation is only a
 * name: the send itself proves its route again through the gated port, so the
 * proof read here is never handed on.
 */

export interface SendToContactRouteCandidateV1 {
    conversationId: string
    channel: SendToContactChannelV1
}

/** The part of a route proof discovery checks: it must describe the candidate it was asked about. */
export interface SendToContactRouteProofV1 {
    chatId: string | null
    channel: string
}

export interface SendToContactRouteDiscoveryInputV1 {
    contactId: string
    /** The canonical Contact the caller evaluated; conversation evidence for any other one is stale. */
    expectedCanonicalContactId: string
    allowedChannels?: readonly SendToContactChannelV1[]
}

export interface SendToContactRouteDiscoveryPortsV1 {
    /** Messaging's own ContactConversationsQuery.v1 entry for exactly this contactId. */
    readContactConversations(contactId: string): Promise<ContactConversationsEntryV1>
    /** The read-only route proof of one persisted conversation; a refusal is thrown as its stable code. */
    proveRoute(candidate: SendToContactRouteCandidateV1): Promise<SendToContactRouteProofV1>
}

export type SendToContactRouteRefusalV1 = Pick<
    SendToContactRefusedV1,
    'reason' | 'retryable' | 'detail' | 'identityStatus' | 'candidateChannels'
>

export type SendToContactRouteSelectionV1 =
    | { kind: 'selected'; conversationId: string; channel: SendToContactChannelV1 }
    | { kind: 'refused'; refusal: SendToContactRouteRefusalV1 }

export type SendToContactRouteCandidatesV1 =
    | { kind: 'candidates'; candidates: SendToContactRouteCandidateV1[] }
    | { kind: 'none'; detail: 'no_conversation' | 'not_in_allowed_channels' }

type RouteProofRefusalDetailV1 = Exclude<
    SendToContactRouteUnavailableDetailV1,
    'no_conversation' | 'not_in_allowed_channels' | 'no_sendable_route'
>

export interface SendToContactRouteProofRefusalV1 {
    detail: RouteProofRefusalDetailV1
    identityStatus?: string
}

type RouteProofOutcomeV1 =
    | { kind: 'proven'; candidate: SendToContactRouteCandidateV1 }
    | ({ kind: 'refused' } & SendToContactRouteProofRefusalV1)
    | { kind: 'unavailable' }

// The route proof's closed set of stable refusals (platform-shell outbound
// conversation identity, MAX transport binding). Anything else it throws —
// a store, network or composition failure — proves nothing either way.
const ROUTE_PROOF_REFUSALS = new Map<string, RouteProofRefusalDetailV1>([
    ['CONTACT_CONVERSATION_IDENTITY_REQUIRED', 'identity_binding_mismatch'],
    ['CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH', 'identity_binding_mismatch'],
    ['CONTACT_CONVERSATION_NOT_PRIVATE', 'conversation_not_private'],
    ['CONTACT_CONVERSATION_TRANSPORT_UNBOUND', 'transport_unbound'],
    ['CONTACT_CONVERSATION_TRANSPORT_MISMATCH', 'transport_mismatch'],
    ['CONTACT_CONVERSATION_PROVIDER_TRANSPORT_MISMATCH', 'transport_mismatch'],
    ['MAX_BOT_DELIVERY_TRANSPORT_UNAVAILABLE', 'transport_unbound'],
])
const IDENTITY_NOT_SENDABLE_PREFIX = 'CONTACT_CONVERSATION_IDENTITY_NOT_SENDABLE:'
const IDENTITY_STATUS_PATTERN = /^[a-z][a-z0-9_]*$/

function isSendToContactChannel(value: string): value is SendToContactChannelV1 {
    return (SEND_TO_CONTACT_CHANNELS_V1 as readonly string[]).includes(value)
}

function unavailable(
    detail: SendToContactRouteUnavailableDetailV1,
    identityStatus?: string,
): SendToContactRouteSelectionV1 {
    return {
        kind: 'refused',
        refusal: { reason: 'route_unavailable', retryable: false, detail, ...(identityStatus ? { identityStatus } : {}) },
    }
}

function incomplete(detail: SendToContactRouteEvidenceIncompleteDetailV1): SendToContactRouteSelectionV1 {
    return { kind: 'refused', refusal: { reason: 'route_evidence_incomplete', retryable: true, detail } }
}

/**
 * Every conversation (not only the primary ones) on a sendable channel the
 * request allows, in the entry's order: channels most recent first, then the
 * conversations inside each. The order makes the search deterministic; it
 * never ranks one route above another.
 */
export function sendToContactRouteCandidatesV1(
    entry: ContactConversationsFoundV1,
    allowedChannels?: readonly SendToContactChannelV1[],
): SendToContactRouteCandidatesV1 {
    const sendable = entry.channels.filter(context => isSendToContactChannel(context.channel))
    if (sendable.every(context => context.conversations.length === 0)) return { kind: 'none', detail: 'no_conversation' }
    const allowed = new Set<string>(allowedChannels ?? SEND_TO_CONTACT_CHANNELS_V1)
    const candidates = sendable
        .filter(context => allowed.has(context.channel))
        .flatMap(context => context.conversations.map(conversation => ({
            conversationId: conversation.conversationId,
            channel: context.channel as SendToContactChannelV1,
        })))
    return candidates.length === 0
        ? { kind: 'none', detail: 'not_in_allowed_channels' }
        : { kind: 'candidates', candidates }
}

/** The stable refusal a route proof threw, or null when the failure proves nothing (fail closed). */
export function classifySendToContactRouteProofFailureV1(error: unknown): SendToContactRouteProofRefusalV1 | null {
    if (!(error instanceof Error)) return null
    const detail = ROUTE_PROOF_REFUSALS.get(error.message)
    if (detail) return { detail }
    if (error.message.startsWith(IDENTITY_NOT_SENDABLE_PREFIX)) {
        const identityStatus = error.message.slice(IDENTITY_NOT_SENDABLE_PREFIX.length)
        return IDENTITY_STATUS_PATTERN.test(identityStatus)
            ? { detail: 'identity_not_sendable', identityStatus }
            : { detail: 'identity_not_sendable' }
    }
    return null
}

async function proveCandidate(
    candidate: SendToContactRouteCandidateV1,
    proveRoute: SendToContactRouteDiscoveryPortsV1['proveRoute'],
): Promise<RouteProofOutcomeV1> {
    let proof: SendToContactRouteProofV1
    try {
        proof = await proveRoute(candidate)
    } catch (error: unknown) {
        const refusal = classifySendToContactRouteProofFailureV1(error)
        return refusal ? { kind: 'refused', ...refusal } : { kind: 'unavailable' }
    }
    // A proof of some other conversation proves nothing about this one.
    if (!proof || proof.chatId !== candidate.conversationId || proof.channel !== candidate.channel) {
        return { kind: 'unavailable' }
    }
    return { kind: 'proven', candidate }
}

/** Every candidate was refused: one shared reason when they all agree, else `no_sendable_route`. */
function sharedRefusal(refusals: SendToContactRouteProofRefusalV1[]): SendToContactRouteSelectionV1 {
    const [first] = refusals
    if (!refusals.every(refusal => refusal.detail === first.detail)) return unavailable('no_sendable_route')
    const sharedStatus = refusals.every(refusal => refusal.identityStatus === first.identityStatus)
        ? first.identityStatus
        : undefined
    return unavailable(first.detail, sharedStatus)
}

/**
 * 1. The Contact's persisted conversations. Unreadable → incomplete; another
 *    canonical Contact or none → lineage moved; truncated → incomplete (partial
 *    evidence never proves a route, nor its uniqueness).
 * 2. Candidates; none at all → no_conversation; none allowed → not_in_allowed_channels.
 * 3. Prove candidates one at a time in entry order, stopping at the second
 *    provable one.
 * 4. Two provable → route_ambiguous (also on one channel: no transport is chosen
 *    silently). Any candidate whose proof proved nothing → incomplete, never a
 *    selection. Exactly one provable → selected. None → route_unavailable.
 */
export async function discoverSendToContactRouteV1(
    input: SendToContactRouteDiscoveryInputV1,
    ports: SendToContactRouteDiscoveryPortsV1,
): Promise<SendToContactRouteSelectionV1> {
    let entry: ContactConversationsEntryV1
    try {
        entry = await ports.readContactConversations(input.contactId)
    } catch {
        return incomplete('conversations_unavailable')
    }
    if (!entry || entry.contactId !== input.contactId) return incomplete('conversations_unavailable')
    if (entry.status !== 'found' || entry.canonicalContactId !== input.expectedCanonicalContactId) {
        return incomplete('lineage_moved')
    }
    if (entry.truncated) return incomplete('truncated')

    const candidates = sendToContactRouteCandidatesV1(entry, input.allowedChannels)
    if (candidates.kind === 'none') return unavailable(candidates.detail)

    const proven: SendToContactRouteCandidateV1[] = []
    const refusals: SendToContactRouteProofRefusalV1[] = []
    let unproven = false
    for (const candidate of candidates.candidates) {
        const outcome = await proveCandidate(candidate, ports.proveRoute)
        if (outcome.kind === 'proven') {
            proven.push(outcome.candidate)
            if (proven.length === 2) break
        } else if (outcome.kind === 'refused') {
            refusals.push({ detail: outcome.detail, ...(outcome.identityStatus ? { identityStatus: outcome.identityStatus } : {}) })
        } else {
            unproven = true
        }
    }

    if (proven.length >= 2) {
        const candidateChannels = [...new Set(proven.map(route => route.channel))].sort()
        return { kind: 'refused', refusal: { reason: 'route_ambiguous', retryable: false, candidateChannels } }
    }
    if (unproven) return incomplete('route_proof_unavailable')
    if (proven.length === 1) return { kind: 'selected', conversationId: proven[0].conversationId, channel: proven[0].channel }
    return sharedRefusal(refusals)
}
