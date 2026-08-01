export const TEXT_SENDER_SCHEMA_VERSION = 1 as const
export const TEXT_SENDER_ENDPOINT = '/v1/personal-max/send/text' as const
export const TEXT_SENDER_AUTH_NAMESPACE = 'personal-max-sender-v1' as const

export type HonestTextSenderOutcome =
  | 'REFUSED_BEFORE_SEND'
  | 'ACCEPTED_BY_SENDER_BOUNDARY'
  | 'PROVIDER_CONFIRMED'
  | 'UNKNOWN_AFTER_ATTEMPT'
  | 'FAILED_BEFORE_PROVIDER'
  | 'UNSUPPORTED'

export interface ExactTextSenderRoute {
  readonly routeVersion: number
  readonly protocolChatId: string
  readonly providerUserId: string | null
  readonly webRouteId: string | null
}

export interface TextSenderRequestV1 {
  readonly schemaVersion: 1
  readonly accountId: string
  readonly conversationKey: string
  readonly route: ExactTextSenderRoute
  readonly commandId: string
  readonly attemptId: string
  readonly attemptCorrelationId: string
  readonly clientMessageId: string | null
  readonly idempotencyKey: string
  readonly ownerInstanceId: string
  readonly fencingToken: string
  readonly payload: { readonly kind: 'text'; readonly text: string; readonly replyToProviderMessageId?: string }
  readonly requestedAt: string
  readonly deadlineAt: string
}

export interface TextSenderAuthenticationV1 {
  readonly namespace: 'personal-max-sender-v1'
  readonly keyId: string
  readonly timestamp: string
  readonly nonce: string
  readonly bodySha256: string
  readonly signature: string
}

export interface BuildTextSenderRequestInput extends Omit<TextSenderRequestV1, 'schemaVersion' | 'fencingToken' | 'requestedAt' | 'deadlineAt'> {
  readonly fencingToken: bigint
  readonly requestedAt: Date
  readonly deadlineAt: Date
}
