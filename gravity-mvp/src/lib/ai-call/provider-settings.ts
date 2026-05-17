/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma client types
   for AiProviderSetting may not be regenerated on every dev box. */

/**
 * DB-backed AI-call provider settings.
 *
 * Each setting is identified by (provider, key):
 *   openai / apiKey         — secret, encrypted
 *   yandex / apiKey         — secret, encrypted
 *   yandex / folderId       — plain (folder ID is public)
 *   system / mockMode       — plain boolean ('true' / 'false')
 *
 * Reads are memoised for 30 seconds so call hot-paths (LLM/STT/TTS) don't
 * hit Postgres on every request. Mutations bust the cache.
 *
 * .env fallback rule:
 *   - If a DB row exists for (provider, key) → use it.
 *   - Otherwise → fall back to the equivalent env var (so dev boxes
 *     still work the moment .env is set, even before anyone configures
 *     anything via the UI).
 */

import { prisma } from '@/lib/prisma'
import { encrypt, decrypt, maskSecret } from './crypto'

const CACHE_TTL_MS = 30_000

export type Provider = 'openai' | 'yandex' | 'system'
export type Key =
    | 'apiKey'    // for openai, yandex
    | 'folderId'  // for yandex
    | 'mockMode'  // for system (boolean stored as 'true'/'false')

interface SettingRow {
    provider: string
    key: string
    encryptedValue: string | null
    valuePlain: string | null
    mask: string | null
    isConfigured: boolean
    lastCheckedAt: Date | null
    lastCheckStatus: string | null
    lastCheckMessage: string | null
    updatedAt: Date
}

// In-memory cache. Keyed by `${provider}:${key}`. Holds the resolved
// plaintext value (or null if the setting is unset/empty). 30-sec TTL —
// short enough that revoking a key in the UI propagates quickly, long
// enough to spare Postgres on the read path.
const cache = new Map<string, { plaintext: string | null; expiresAt: number }>()

function cacheKey(provider: string, key: string): string {
    return `${provider}:${key}`
}

function readEnvFallback(provider: Provider, key: Key): string | null {
    const v =
        provider === 'openai' && key === 'apiKey' ? process.env.OPENAI_API_KEY :
        provider === 'yandex' && key === 'apiKey' ? process.env.YANDEX_API_KEY :
        provider === 'yandex' && key === 'folderId' ? process.env.YANDEX_FOLDER_ID :
        provider === 'system' && key === 'mockMode' ? process.env.AI_CALL_MOCK_MODE :
        null
    return v ? v.trim() || null : null
}

/**
 * Resolve the current effective value for a setting.
 * - First checks the in-memory cache.
 * - Then the DB (decrypting if needed).
 * - Then process.env as fallback.
 * - Caches the result (including `null` misses, to avoid hammering
 *   the DB for unset settings).
 */
export async function getValue(provider: Provider, key: Key): Promise<string | null> {
    const ck = cacheKey(provider, key)
    const hit = cache.get(ck)
    if (hit && hit.expiresAt > Date.now()) return hit.plaintext

    let plaintext: string | null = null

    try {
        const row = await (prisma as any).aiProviderSetting.findUnique({
            where: { provider_key: { provider, key } },
            select: { encryptedValue: true, valuePlain: true, isConfigured: true },
        }) as Pick<SettingRow, 'encryptedValue' | 'valuePlain' | 'isConfigured'> | null

        if (row && row.isConfigured) {
            if (row.encryptedValue) {
                try {
                    plaintext = decrypt(row.encryptedValue)
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    console.error(`[provider-settings] decrypt failed for ${provider}/${key}: ${msg}`)
                    plaintext = null
                }
            } else if (row.valuePlain != null) {
                plaintext = row.valuePlain
            }
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[provider-settings] db read failed for ${provider}/${key}: ${msg}`)
    }

    if (plaintext == null) plaintext = readEnvFallback(provider, key)

    cache.set(ck, { plaintext, expiresAt: Date.now() + CACHE_TTL_MS })
    return plaintext
}

export interface SaveOpts {
    /** If true, value is treated as a secret and AES-encrypted. */
    secret?: boolean
}

/**
 * Persist a setting. Empty/whitespace value → delete the row.
 */
export async function saveValue(provider: Provider, key: Key, rawValue: string, opts: SaveOpts = {}): Promise<void> {
    const value = (rawValue ?? '').trim()
    if (!value) {
        await deleteValue(provider, key)
        return
    }

    const isSecret = opts.secret ?? true
    const data = isSecret
        ? { encryptedValue: encrypt(value), valuePlain: null, mask: maskSecret(value) }
        : { encryptedValue: null, valuePlain: value, mask: maskSecret(value) }

    await (prisma as any).aiProviderSetting.upsert({
        where: { provider_key: { provider, key } },
        create: {
            provider,
            key,
            ...data,
            isConfigured: true,
        },
        update: {
            ...data,
            isConfigured: true,
            // Reset check state — a freshly saved value hasn't been
            // verified yet.
            lastCheckedAt: null,
            lastCheckStatus: null,
            lastCheckMessage: null,
        },
    })

    cache.delete(cacheKey(provider, key))
}

export async function deleteValue(provider: Provider, key: Key): Promise<void> {
    await (prisma as any).aiProviderSetting.deleteMany({
        where: { provider, key },
    })
    cache.delete(cacheKey(provider, key))
}

export async function recordCheck(
    provider: Provider,
    key: Key,
    status: 'ok' | 'invalid_key' | 'no_key' | 'no_folder' | 'network' | 'http_error',
    message: string,
): Promise<void> {
    await (prisma as any).aiProviderSetting.updateMany({
        where: { provider, key },
        data: {
            lastCheckedAt: new Date(),
            lastCheckStatus: status,
            lastCheckMessage: message,
        },
    })
}

export interface SettingStatus {
    configured: boolean
    mask: string | null
    /** 'db' — value comes from DB; 'env' — fallback to .env (dev mode); 'none' — unset. */
    source: 'db' | 'env' | 'none'
    lastCheckedAt: string | null
    lastCheckStatus: string | null
    lastCheckMessage: string | null
}

/**
 * Public status snapshot for the settings UI. Never returns plaintext.
 * Used by GET /api/settings/ai-call-keys.
 */
export async function getStatus(provider: Provider, key: Key): Promise<SettingStatus> {
    let row: SettingRow | null = null
    try {
        row = await (prisma as any).aiProviderSetting.findUnique({
            where: { provider_key: { provider, key } },
        }) as SettingRow | null
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[provider-settings] getStatus db read failed for ${provider}/${key}: ${msg}`)
    }

    if (row && row.isConfigured) {
        return {
            configured: true,
            mask: row.mask,
            source: 'db',
            lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
            lastCheckStatus: row.lastCheckStatus,
            lastCheckMessage: row.lastCheckMessage,
        }
    }

    // No DB row → maybe env has a fallback.
    const envValue = readEnvFallback(provider, key)
    if (envValue) {
        return {
            configured: true,
            mask: maskSecret(envValue),
            source: 'env',
            lastCheckedAt: null,
            lastCheckStatus: null,
            lastCheckMessage: null,
        }
    }
    return {
        configured: false,
        mask: null,
        source: 'none',
        lastCheckedAt: null,
        lastCheckStatus: null,
        lastCheckMessage: null,
    }
}

/** Convenience: is mock mode currently enabled? Reads DB → env. */
export async function isMockModeEnabled(): Promise<boolean> {
    const v = await getValue('system', 'mockMode')
    return v === 'true'
}

/** Convenience: full plaintext map for the bridge — never expose this. */
export async function getAllPlaintext(): Promise<{
    openaiApiKey: string | null
    yandexApiKey: string | null
    yandexFolderId: string | null
    mockMode: boolean
}> {
    const [openaiApiKey, yandexApiKey, yandexFolderId, mockModeRaw] = await Promise.all([
        getValue('openai', 'apiKey'),
        getValue('yandex', 'apiKey'),
        getValue('yandex', 'folderId'),
        getValue('system', 'mockMode'),
    ])
    return {
        openaiApiKey,
        yandexApiKey,
        yandexFolderId,
        mockMode: mockModeRaw === 'true',
    }
}
