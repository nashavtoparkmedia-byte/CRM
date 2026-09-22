import { createPrivateKey, type KeyObject } from 'node:crypto'

/**
 * Mobile Push v1 configuration.
 *
 * MOBILE_PUSH_ENABLED is off unless it is exactly `true`. Off is a deliberate
 * state: no intent is written, nothing is fanned out, no provider is called,
 * and Messaging behaves exactly as it did before push existed.
 *
 * On with missing or invalid FCM configuration is NOT off. It is operational
 * misconfiguration, reported as a named problem so deliveries fail visibly and
 * retry into the outbox's bounded dead-letter state instead of being quietly
 * dropped. No problem description ever contains a credential value.
 */

export interface MobilePushEnvironmentV1 {
    NODE_ENV?: string
    MOBILE_PUSH_ENABLED?: string
    MOBILE_PUSH_FCM_PROJECT_ID?: string
    MOBILE_PUSH_FCM_CLIENT_EMAIL?: string
    MOBILE_PUSH_FCM_PRIVATE_KEY?: string
    MOBILE_PUSH_FCM_ENDPOINT_OVERRIDE?: string
}

export interface FcmTransportConfigV1 {
    projectId: string
    clientEmail: string
    privateKey: KeyObject
    oauthTokenUrl: string
    sendUrl: string
    /** The JWT audience Google requires: its own token endpoint, even under an override. */
    oauthAudience: string
    /** A non-production stand-in is in use. */
    overridden: boolean
}

export type FcmTransportConfigProblemV1 =
    | 'missing_project_id'
    | 'missing_client_email'
    | 'missing_private_key'
    | 'invalid_private_key'
    | 'endpoint_override_refused'

export type FcmTransportConfigResultV1 =
    | { ok: true, config: FcmTransportConfigV1 }
    | { ok: false, problem: FcmTransportConfigProblemV1 }

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_FCM_API_BASE = 'https://fcm.googleapis.com'
const PROJECT_ID = /^[a-z][a-z0-9-]{4,62}[a-z0-9]$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function currentEnvironment(): MobilePushEnvironmentV1 {
    return {
        NODE_ENV: process.env.NODE_ENV,
        MOBILE_PUSH_ENABLED: process.env.MOBILE_PUSH_ENABLED,
        MOBILE_PUSH_FCM_PROJECT_ID: process.env.MOBILE_PUSH_FCM_PROJECT_ID,
        MOBILE_PUSH_FCM_CLIENT_EMAIL: process.env.MOBILE_PUSH_FCM_CLIENT_EMAIL,
        MOBILE_PUSH_FCM_PRIVATE_KEY: process.env.MOBILE_PUSH_FCM_PRIVATE_KEY,
        MOBILE_PUSH_FCM_ENDPOINT_OVERRIDE: process.env.MOBILE_PUSH_FCM_ENDPOINT_OVERRIDE,
    }
}

export function isMobilePushEnabledV1(env: MobilePushEnvironmentV1 = currentEnvironment()): boolean {
    return env.MOBILE_PUSH_ENABLED?.trim() === 'true'
}

/**
 * A stand-in endpoint is accepted only outside production and only on the
 * loopback interface. In production any override is a configuration error:
 * it is refused outright rather than ignored, so a misplaced value can neither
 * redirect pushes nor silently fall back.
 */
function resolveEndpoints(env: MobilePushEnvironmentV1, projectId: string):
    { ok: true, oauthTokenUrl: string, sendUrl: string, overridden: boolean } | { ok: false } {
    const override = env.MOBILE_PUSH_FCM_ENDPOINT_OVERRIDE?.trim() ?? ''
    if (override === '') {
        return {
            ok: true,
            oauthTokenUrl: GOOGLE_OAUTH_TOKEN_URL,
            sendUrl: `${GOOGLE_FCM_API_BASE}/v1/projects/${projectId}/messages:send`,
            overridden: false,
        }
    }
    if (env.NODE_ENV === 'production') return { ok: false }
    let parsed: URL
    try {
        parsed = new URL(override)
    } catch {
        return { ok: false }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false }
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) return { ok: false }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return { ok: false }
    const base = parsed.origin
    return {
        ok: true,
        oauthTokenUrl: `${base}/token`,
        sendUrl: `${base}/v1/projects/${projectId}/messages:send`,
        overridden: true,
    }
}

export function readFcmTransportConfigV1(env: MobilePushEnvironmentV1 = currentEnvironment()): FcmTransportConfigResultV1 {
    const projectId = env.MOBILE_PUSH_FCM_PROJECT_ID?.trim() ?? ''
    if (!PROJECT_ID.test(projectId)) return { ok: false, problem: 'missing_project_id' }
    const clientEmail = env.MOBILE_PUSH_FCM_CLIENT_EMAIL?.trim() ?? ''
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail) || clientEmail.length > 320) {
        return { ok: false, problem: 'missing_client_email' }
    }
    const rawKey = env.MOBILE_PUSH_FCM_PRIVATE_KEY ?? ''
    if (rawKey.trim() === '') return { ok: false, problem: 'missing_private_key' }

    let privateKey: KeyObject
    try {
        // Service-account keys are PEM; env files commonly carry `\n` escapes.
        privateKey = createPrivateKey({ key: rawKey.replace(/\\n/g, '\n'), format: 'pem' })
    } catch {
        return { ok: false, problem: 'invalid_private_key' }
    }
    if (privateKey.asymmetricKeyType !== 'rsa') return { ok: false, problem: 'invalid_private_key' }

    const endpoints = resolveEndpoints(env, projectId)
    if (!endpoints.ok) return { ok: false, problem: 'endpoint_override_refused' }

    return {
        ok: true,
        config: {
            projectId,
            clientEmail,
            privateKey,
            oauthTokenUrl: endpoints.oauthTokenUrl,
            sendUrl: endpoints.sendUrl,
            oauthAudience: GOOGLE_OAUTH_TOKEN_URL,
            overridden: endpoints.overridden,
        },
    }
}
