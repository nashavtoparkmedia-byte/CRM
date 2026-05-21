/**
 * Symmetric AES-256-GCM encryption for secrets stored in the
 * AiProviderSetting table.
 *
 * Why not a managed secrets manager:
 *   - MVP, on-prem deployment, no KMS in the picture.
 *   - The threat model we care about is "someone gets a pg_dump" — at-rest
 *     ciphertext defeats that as long as the master key isn't in the dump.
 *
 * Where the master key comes from:
 *   1. AI_CALL_ENC_KEY env var (32-byte base64) — production path.
 *   2. Derived from DATABASE_URL hash — dev/CI path, deterministic per
 *      database. Means we never blow up because someone forgot to set the
 *      key, but `pg_dump` + DATABASE_URL = decryption. Acceptable for
 *      single-tenant on-prem; not for SaaS.
 *
 * The derivation strategy is logged once at boot so it's obvious in prod
 * if the env var wasn't actually applied.
 */

import crypto from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12   // GCM standard; 12 bytes
const TAG_LENGTH = 16  // GCM standard; 16-byte auth tag

let cachedKey: Buffer | null = null
let keyOrigin: 'env' | 'derived' | null = null

function getMasterKey(): Buffer {
    if (cachedKey) return cachedKey

    const fromEnv = process.env.AI_CALL_ENC_KEY
    if (fromEnv) {
        try {
            const buf = Buffer.from(fromEnv, 'base64')
            if (buf.length !== 32) {
                throw new Error(`AI_CALL_ENC_KEY must decode to 32 bytes, got ${buf.length}`)
            }
            cachedKey = buf
            keyOrigin = 'env'
            console.log('[ai-call/crypto] using AI_CALL_ENC_KEY (production-grade)')
            return cachedKey
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(`AI_CALL_ENC_KEY is set but invalid: ${msg}`)
        }
    }

    // Dev/CI fallback: derive from DATABASE_URL so it stays stable per
    // installation but doesn't require an extra config knob. This is
    // explicitly NOT for production — see the module comment.
    const databaseUrl = process.env.DATABASE_URL ?? 'fallback-dev-only-do-not-trust-this'
    cachedKey = crypto
        .createHash('sha256')
        .update('ai-call-secrets:' + databaseUrl)
        .digest()
    keyOrigin = 'derived'
    console.log('[ai-call/crypto] AI_CALL_ENC_KEY not set — derived dev key from DATABASE_URL')
    return cachedKey
}

export function getKeyOrigin(): 'env' | 'derived' | null {
    if (!cachedKey) getMasterKey()
    return keyOrigin
}

/**
 * Encrypt a UTF-8 string. Output format (single token, no separators):
 *   base64(iv) || base64(authTag) || base64(ciphertext)
 * — with dot separators so it's URL/log-safe.
 */
export function encrypt(plaintext: string): string {
    if (!plaintext) throw new Error('encrypt: empty plaintext')
    const key = getMasterKey()
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.')
}

/**
 * Decrypt a token produced by encrypt(). Throws on tamper / wrong-key.
 */
export function decrypt(token: string): string {
    if (!token) throw new Error('decrypt: empty token')
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('decrypt: malformed token')
    const [ivB64, tagB64, ctB64] = parts
    const iv = Buffer.from(ivB64, 'base64')
    const tag = Buffer.from(tagB64, 'base64')
    const ct = Buffer.from(ctB64, 'base64')
    if (iv.length !== IV_LENGTH) throw new Error(`decrypt: bad IV length ${iv.length}`)
    if (tag.length !== TAG_LENGTH) throw new Error(`decrypt: bad tag length ${tag.length}`)

    const key = getMasterKey()
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return pt.toString('utf8')
}

/**
 * Last-4-char mask for UI display. Mirrors the existing helper from
 * keys-status.ts so the mask format stays consistent.
 */
export function maskSecret(value: string | undefined | null): string | null {
    if (!value) return null
    const trimmed = value.trim()
    if (!trimmed) return null
    const tail = trimmed.length >= 4 ? trimmed.slice(-4) : trimmed
    return `•••• ${tail}`
}
