import { afterEach, describe, expect, it, vi } from 'vitest'

import { isBridgeMachineRequestAuthenticated } from './bridge-machine-auth'

const VALID_TOKEN = 'A'.repeat(32)

function requestHeaders(token?: string): Headers {
    const headers = new Headers()
    if (token !== undefined) headers.set('x-bridge-token', token)
    return headers
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe('AudioBridge machine authentication', () => {
    it.each([
        ['missing configured secret', VALID_TOKEN, undefined],
        ['missing request header', undefined, VALID_TOKEN],
        ['malformed request token', 'short', VALID_TOKEN],
        ['malformed configured secret', VALID_TOKEN, 'short'],
        ['wrong token', 'B'.repeat(32), VALID_TOKEN],
        ['equivalent-length wrong token', `${'A'.repeat(31)}B`, VALID_TOKEN],
    ])('fails closed for %s', (_case, supplied, configured) => {
        expect(isBridgeMachineRequestAuthenticated(
            requestHeaders(supplied),
            configured,
        )).toBe(false)
    })

    it('accepts the exact well-formed shared token', () => {
        expect(isBridgeMachineRequestAuthenticated(
            requestHeaders(VALID_TOKEN),
            VALID_TOKEN,
        )).toBe(true)
    })

    it('does not log either token on a denied request', () => {
        const logSpies = [
            vi.spyOn(console, 'debug').mockImplementation(() => undefined),
            vi.spyOn(console, 'info').mockImplementation(() => undefined),
            vi.spyOn(console, 'warn').mockImplementation(() => undefined),
            vi.spyOn(console, 'error').mockImplementation(() => undefined),
            vi.spyOn(console, 'log').mockImplementation(() => undefined),
        ]

        expect(isBridgeMachineRequestAuthenticated(
            requestHeaders('B'.repeat(32)),
            VALID_TOKEN,
        )).toBe(false)
        for (const spy of logSpies) expect(spy).not.toHaveBeenCalled()
    })
})
