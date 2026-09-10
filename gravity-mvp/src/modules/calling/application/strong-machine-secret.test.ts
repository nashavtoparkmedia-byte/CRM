import { describe, expect, it } from 'vitest'
import { isControlledRealCallOperatorAuthenticated } from './controlled-real-ai-call-operator-auth'
import { isStrongMachineSecret } from './strong-machine-secret'

const strongToken = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/=-token'

describe('controlled real-call machine secrets', () => {
    it('rejects public placeholders and low-entropy test values', () => {
        expect(isStrongMachineSecret('__GENERATE_WITH_openssl_rand_base64_32__')).toBe(false)
        expect(isStrongMachineSecret('A'.repeat(64))).toBe(false)
        expect(isStrongMachineSecret('ClueCon')).toBe(false)
    })

    it('requires an exact constant-time operator token match', () => {
        expect(isControlledRealCallOperatorAuthenticated(
            new Headers({ 'x-controlled-real-call-token': strongToken }),
            strongToken,
        )).toBe(true)
        expect(isControlledRealCallOperatorAuthenticated(
            new Headers({ 'x-controlled-real-call-token': `${strongToken}x` }),
            strongToken,
        )).toBe(false)
    })
})
