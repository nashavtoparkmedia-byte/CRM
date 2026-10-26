import { createHash } from 'node:crypto'
import {
    SEND_TO_CONTACT_COMMAND_V1,
    parseSendToContactCommandV1,
    type SendToContactCommandV1,
} from '../../../contracts/messaging/v1/send-to-contact-command'

/**
 * A validated SendToContact request and the identity it claims, before any
 * read or write. Pure: no IO, no clock, no randomness.
 */
export interface PreparedSendToContactRequestV1 {
    command: SendToContactCommandV1
    /** sha256 of the semantic payload; the value a requestId is bound to, permanently. */
    semanticPayloadSha256: string
    /** The `Message.clientMessageId` of the one Message this intent may ever admit. */
    clientMessageId: string
}

/**
 * The semantic payload fingerprint:
 *   lowercase hex sha256(UTF-8(JSON.stringify([contract id, contactId, content, allowedChannels])))
 * - contract id: a later version reusing a requestId conflicts instead of becoming a second intent;
 * - contactId exactly as supplied, never canonicalised: a merge must not turn a retry into a conflict;
 * - content exactly as supplied: the provider receives exactly this text;
 * - allowedChannels: null when absent, else the set in ordinal order. Order carries no meaning, and
 *   absent is not the full set (a channel added later would be allowed by absent only).
 * Excluded: the requestId (the key) and everything evaluation produces — route, conversation,
 * canonical Contact, time, actor, transport. A JSON array fixes the field order and escapes every
 * value, so no field can forge a boundary.
 */
export function sendToContactSemanticPayloadSha256V1(command: SendToContactCommandV1): string {
    const canonical = JSON.stringify([
        SEND_TO_CONTACT_COMMAND_V1,
        command.contactId,
        command.content,
        command.allowedChannels === undefined ? null : [...command.allowedChannels].sort(),
    ])
    return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/** `"stc:" + requestId`: a namespace only SendToContact mints, one Message per intent. */
export function sendToContactClientMessageIdV1(requestId: string): string {
    return `stc:${requestId}`
}

/**
 * Claim order, steps 1–3: contract and version validation, input validation,
 * then the canonical fingerprint. It throws `SendToContactValidationError` for
 * a malformed or unsupported command, so such a command never reaches the claim
 * and never reserves its requestId.
 */
export function prepareSendToContactRequestV1(input: unknown): PreparedSendToContactRequestV1 {
    const command = parseSendToContactCommandV1(input)
    return {
        command,
        semanticPayloadSha256: sendToContactSemanticPayloadSha256V1(command),
        clientMessageId: sendToContactClientMessageIdV1(command.requestId),
    }
}
