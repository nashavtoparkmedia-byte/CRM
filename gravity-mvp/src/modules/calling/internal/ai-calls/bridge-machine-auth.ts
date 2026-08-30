import { createHash, timingSafeEqual } from 'node:crypto'

const BRIDGE_TOKEN_HEADER = 'x-bridge-token'
const BRIDGE_TOKEN_PATTERN = /^[A-Za-z0-9_+/=-]{32,172}$/

type HeaderReader = Pick<Headers, 'get'>

function isWellFormedToken(value: string | null | undefined): value is string {
    return typeof value === 'string' && BRIDGE_TOKEN_PATTERN.test(value)
}

function tokenDigest(value: string): Buffer {
    return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * Authenticate a machine callback from AudioBridge.
 *
 * Both inputs must be well-formed before their fixed-length SHA-256 digests
 * are compared. Missing configuration and every invalid request fail closed.
 * The boolean-only API keeps denial responses generic and secret-free.
 */
export function isBridgeMachineRequestAuthenticated(
    headers: HeaderReader,
    configuredToken: string | undefined = process.env.BRIDGE_SHARED_TOKEN,
): boolean {
    if (!isWellFormedToken(configuredToken)) return false

    const suppliedToken = headers.get(BRIDGE_TOKEN_HEADER)
    if (!isWellFormedToken(suppliedToken)) return false

    return timingSafeEqual(tokenDigest(suppliedToken), tokenDigest(configuredToken))
}
