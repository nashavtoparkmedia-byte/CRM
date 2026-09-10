import { createHash, timingSafeEqual } from 'node:crypto'

const SAFE_SECRET_CHARACTERS = /^[A-Za-z0-9_+/=-]+$/
const PLACEHOLDER = /(?:__|replace|generate|change.?me|example|placeholder|cluecon)/i

export function isStrongMachineSecret(
    value: string | null | undefined,
    minimumLength = 32,
): value is string {
    if (typeof value !== 'string' || value.length < minimumLength || value.length > 172) return false
    if (!SAFE_SECRET_CHARACTERS.test(value) || PLACEHOLDER.test(value)) return false
    return new Set(value).size >= 8
}

export function constantTimeSecretMatch(supplied: string, configured: string): boolean {
    const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()
    return timingSafeEqual(digest(supplied), digest(configured))
}
