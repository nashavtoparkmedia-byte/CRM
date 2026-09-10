import { constantTimeSecretMatch, isStrongMachineSecret } from '../../application/strong-machine-secret'

const BRIDGE_TOKEN_HEADER = 'x-bridge-token'

type HeaderReader = Pick<Headers, 'get'>

export function isBridgeMachineTokenWellFormed(value: string | null | undefined): value is string {
    return isStrongMachineSecret(value)
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
    if (!isBridgeMachineTokenWellFormed(configuredToken)) return false

    const suppliedToken = headers.get(BRIDGE_TOKEN_HEADER)
    if (!isBridgeMachineTokenWellFormed(suppliedToken)) return false

    return constantTimeSecretMatch(suppliedToken, configuredToken)
}
