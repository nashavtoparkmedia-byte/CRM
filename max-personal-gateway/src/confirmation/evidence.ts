import { createHash } from 'node:crypto'
import type { JsonValue } from '../journal/types.ts'
import { MAX_PROVIDER_CONFIRMATION_EVIDENCE_VERSION } from './constants.ts'
import { RECEIPT_SEMANTICS, type ConfirmationReceiptType } from './receiptSemantics.ts'
import type { ProviderConfirmationEvidenceKind } from './types.ts'

export interface NormalizedConfirmationSource {
  readonly normalizedEventId: string
  readonly accountId: string
  readonly sourceObservationId: string
  readonly sourceJournalSequence: bigint
  readonly eventOrdinal: number
  readonly eventKind: string
  readonly direction: string
  readonly origin: string
  readonly providerMessageId: string | null
  readonly providerUserId: string | null
  readonly protocolChatId: string | null
  readonly webRouteId: string | null
  readonly clientMessageId: string | null
  readonly targetProviderMessageId: string | null
  readonly providerOccurredAt: Date | null
  readonly normalizedPayload: JsonValue
  readonly semanticSha256: string
}
export interface ConfirmationEvidenceDraft {
  readonly evidenceVersion: string
  readonly evidenceKind: ProviderConfirmationEvidenceKind
  readonly providerMessageId: string | null
  readonly attemptCorrelationId: string | null
  readonly clientMessageId: string | null
  readonly protocolChatId: string | null
  readonly providerUserId: string | null
  readonly webRouteId: string | null
  readonly providerOccurredAt: Date | null
  readonly evidenceSha256: string
  readonly safeMetadata: JsonValue
  readonly positiveAcceptanceEligible: boolean
  readonly issueCode: string | null
  readonly ignored: boolean
  readonly receiptType: ConfirmationReceiptType | null
}

function exactString(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null
}

function payloadObject(value: JsonValue): Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>> : Object.freeze({})
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`
}

export function classifyConfirmationEvidence(source: NormalizedConfirmationSource): ConfirmationEvidenceDraft {
  const payload = payloadObject(source.normalizedPayload)
  const attemptCorrelationId = exactString(payload.attemptCorrelationId, 256)
  const payloadClientMessageId = exactString(payload.clientMessageId, 256)
  const clientMessageId = exactString(source.clientMessageId, 256) ?? payloadClientMessageId
  const receiptValue = exactString(payload.receiptType, 64)
  const receiptType: ConfirmationReceiptType | null = receiptValue !== null
    && Object.hasOwn(RECEIPT_SEMANTICS, receiptValue) ? receiptValue as ConfirmationReceiptType : null

  let evidenceKind: ProviderConfirmationEvidenceKind = 'unsupported'
  let providerMessageId = exactString(source.providerMessageId, 512)
  let ignored = true
  let positiveAcceptanceEligible = false
  let issueCode: string | null = 'UNSUPPORTED_EVENT'

  if (source.eventKind === 'message' && source.direction === 'outbound_echo') {
    evidenceKind = 'outbound_echo'
    ignored = false
    issueCode = providerMessageId === null
      ? 'MISSING_PROVIDER_MESSAGE_ID'
      : attemptCorrelationId === null && clientMessageId === null
        ? 'MISSING_EXACT_CORRELATION'
        : null
    positiveAcceptanceEligible = issueCode === null
  } else if (source.eventKind === 'receipt') {
    const semantics = receiptType === null ? RECEIPT_SEMANTICS.unknown_receipt : RECEIPT_SEMANTICS[receiptType]
    evidenceKind = semantics.evidenceKind
    ignored = false
    providerMessageId = exactString(source.targetProviderMessageId, 512) ?? providerMessageId
    issueCode = receiptType === null || receiptType === 'unknown_receipt'
      ? 'UNKNOWN_RECEIPT'
      : providerMessageId === null
        ? 'MISSING_PROVIDER_MESSAGE_ID'
        : receiptType === 'provider_acceptance' && attemptCorrelationId === null && clientMessageId === null
          ? 'MISSING_EXACT_CORRELATION'
          : null
    positiveAcceptanceEligible = semantics.impliesProviderAcceptance && issueCode === null
  } else if (source.eventKind === 'message' && source.direction === 'inbound') {
    issueCode = 'INBOUND_MESSAGE_NOT_CONFIRMATION'
  } else if (source.eventKind === 'reaction') {
    issueCode = 'REACTION_NOT_CONFIRMATION'
  } else if (source.eventKind === 'route_evidence') {
    issueCode = 'ROUTE_EVIDENCE_NOT_CONFIRMATION'
  }

  const safeMetadata: JsonValue = {
    evidenceVersion: MAX_PROVIDER_CONFIRMATION_EVIDENCE_VERSION,
    eventKind: source.eventKind,
    direction: source.direction,
    origin: source.origin,
    receiptType,
    semanticSha256: source.semanticSha256,
  }
  const evidenceSha256 = createHash('sha256').update(canonical({
    accountId: source.accountId,
    normalizedEventId: source.normalizedEventId,
    evidenceKind,
    providerMessageId,
    attemptCorrelationId,
    clientMessageId,
    protocolChatId: source.protocolChatId,
    providerUserId: source.providerUserId,
    webRouteId: source.webRouteId,
    providerOccurredAt: source.providerOccurredAt?.toISOString() ?? null,
    semanticSha256: source.semanticSha256,
  }), 'utf8').digest('hex')

  return Object.freeze({
    evidenceVersion: MAX_PROVIDER_CONFIRMATION_EVIDENCE_VERSION,
    evidenceKind,
    providerMessageId,
    attemptCorrelationId,
    clientMessageId,
    protocolChatId: exactString(source.protocolChatId, 512),
    providerUserId: exactString(source.providerUserId, 512),
    webRouteId: exactString(source.webRouteId, 512),
    providerOccurredAt: source.providerOccurredAt,
    evidenceSha256,
    safeMetadata,
    positiveAcceptanceEligible,
    issueCode,
    ignored,
    receiptType,
  })
}
