/**
 * Mobile Push v1 — provider-neutral transport port.
 *
 * Dispatch depends only on this. The FCM HTTP v1 adapter implements it, so no
 * provider type, SDK or runtime API reaches the delivery rules.
 */

export type MobilePushSendOutcomeV1 =
    | { kind: 'delivered' }
    | { kind: 'retryable', code: string }
    | { kind: 'token_unregistered' }
    | { kind: 'token_invalid' }
    | { kind: 'sender_mismatch' }
    | { kind: 'terminal', code: string }

export interface MobilePushMessageV1 {
    token: string
    data: Readonly<Record<string, string>>
}

export interface MobilePushTransportV1 {
    send(message: MobilePushMessageV1): Promise<MobilePushSendOutcomeV1>
}

/** Why an ENABLED transport cannot be built. Never contains a credential value. */
export type MobilePushTransportProblemV1 =
    | 'missing_project_id'
    | 'missing_client_email'
    | 'missing_private_key'
    | 'invalid_private_key'
    | 'endpoint_override_refused'
