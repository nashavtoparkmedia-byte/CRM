import { constantTimeSecretMatch, isStrongMachineSecret } from './strong-machine-secret'

const CONTROL_TOKEN_HEADER = 'x-controlled-real-call-token'
type HeaderReader = Pick<Headers, 'get'>

export function isControlledRealCallOperatorAuthenticated(
    headers: HeaderReader,
    configuredToken: string | undefined = process.env.AI_CALL_CONTROLLED_OPERATOR_TOKEN,
): boolean {
    if (!isStrongMachineSecret(configuredToken, 43)) return false
    const supplied = headers.get(CONTROL_TOKEN_HEADER)
    if (!isStrongMachineSecret(supplied, 43)) return false
    return constantTimeSecretMatch(supplied, configuredToken)
}
