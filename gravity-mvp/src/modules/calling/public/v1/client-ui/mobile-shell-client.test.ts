import { describe, expect, it } from 'vitest'
import { isMobileShellUserAgentV1 } from './mobile-shell-client'

/**
 * Presentation only. This decides what the operator is offered, never what they
 * are allowed to do - the SIP credential refusal that actually protects the
 * softphone is enforced server-side and is not keyed on this function.
 */

describe('recognising the Android CRM shell from its User-Agent', () => {
    it('recognises the shell token the app appends', () => {
        expect(isMobileShellUserAgentV1('Mozilla/5.0 (Linux; Android 14) YokoShell/0.1.0')).toBe(true)
        expect(isMobileShellUserAgentV1('Mozilla/5.0 (Linux; Android 14) YokoShell/0.1.0 (run/abc123)')).toBe(true)
    })

    it('an ordinary browser is not the shell', () => {
        for (const ua of [
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/128.0',
            'Mozilla/5.0 (Linux; Android 14; SM-S918B) Chrome/128.0 Mobile Safari/537.36',
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1',
        ]) {
            expect(isMobileShellUserAgentV1(ua)).toBe(false)
        }
    })

    it('a missing or empty User-Agent is not the shell', () => {
        expect(isMobileShellUserAgentV1(undefined)).toBe(false)
        expect(isMobileShellUserAgentV1(null)).toBe(false)
        expect(isMobileShellUserAgentV1('')).toBe(false)
    })

    it('a lookalike token is not the shell', () => {
        expect(isMobileShellUserAgentV1('Mozilla/5.0 yokoshell/0.1.0')).toBe(false)
        expect(isMobileShellUserAgentV1('Mozilla/5.0 YokoShellish')).toBe(false)
        expect(isMobileShellUserAgentV1('Mozilla/5.0 YokoShell')).toBe(false)
    })
})
