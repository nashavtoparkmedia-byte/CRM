// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboundCallingMode } from '@/infrastructure/ui/calling-client-capability'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isMobileShellUserAgentV1 } from './mobile-shell-client'

/**
 * Calling's CallButton, driven through the mode its own SipProvider publishes.
 *
 * The provider is replaced by its hook so the mode can be supplied without
 * standing up a SIP stack. Fleet proves its twin in its own test, and
 * `check-calling-client-ui-boundary` proves the two are one implementation
 * modulo the capability seam - so no cross-context import is needed here.
 */

const sip = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock('@/modules/calling/public/v1/sip-client-context', () => ({
    useSip: () => sip.current,
}))

import CallButton from './CallButton'

const PHONE = '+79990000001'

function useSipValue(outboundMode: OutboundCallingMode, overrides: Record<string, unknown> = {}) {
    sip.current = {
        status: 'registered',
        outboundMode,
        activeCall: null,
        startPlaceholderOutbound: vi.fn(),
        cancelPlaceholderOutbound: vi.fn(),
        setActiveCallFsUuid: vi.fn(),
        ...overrides,
    }
    return sip.current
}

const renderCallButton = () => render(<CallButton phoneNumber={PHONE}/>)

describe('outbound calling presented as the system dialer', () => {
    let fetchSpy: ReturnType<typeof vi.fn>
    let getUserMedia: ReturnType<typeof vi.fn>

    beforeEach(() => {
        fetchSpy = vi.fn()
        getUserMedia = vi.fn()
        vi.stubGlobal('fetch', fetchSpy)
        Object.defineProperty(globalThis.navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia },
        })
    })

    afterEach(() => {
        cleanup()
        vi.unstubAllGlobals()
    })

    it('offers a tel: link the device can hand to its own dialer', () => {
        useSipValue('system_dialer')
        renderCallButton()

        const link = screen.getByRole('link', { name: /Позвонить/ })
        expect(link.getAttribute('href')).toBe(`tel:${PHONE}`)
        // A link, not a button: nothing to disable and nothing to submit.
        expect(screen.queryByRole('button')).toBeNull()
    })

    it('offers the dialer even with no softphone registration and no active call state', () => {
        // This is the whole point: in the shell the softphone can never register,
        // so a disabled button would be the only thing an operator ever saw.
        for (const status of ['idle', 'connecting', 'unregistered', 'failed', 'disabled', 'identity-required'] as const) {
            useSipValue('system_dialer', { status })
            renderCallButton()
            expect(screen.getByRole('link', { name: /Позвонить/ }).getAttribute('href')).toBe(`tel:${PHONE}`)
            cleanup()
        }
    })

    it('places no call itself: no originate, no microphone, no placeholder SIP state', () => {
        const value = useSipValue('system_dialer')
        renderCallButton()

        screen.getByRole('link', { name: /Позвонить/ }).click()

        expect(fetchSpy).not.toHaveBeenCalled()
        expect(getUserMedia).not.toHaveBeenCalled()
        expect(value.startPlaceholderOutbound).not.toHaveBeenCalled()
        expect(value.setActiveCallFsUuid).not.toHaveBeenCalled()
    })

    it('carries the number in the link and nothing else', () => {
        useSipValue('system_dialer')
        renderCallButton()
        const link = screen.getByRole('link', { name: /Позвонить/ })
        // No telephony permission, no auto-dial attribute, no target that could
        // navigate the shell away from the CRM.
        expect(link.getAttribute('href')).toBe(`tel:${PHONE}`)
        expect(link.getAttribute('target')).toBeNull()
        expect(link.getAttribute('download')).toBeNull()
    })
})

describe('outbound calling presented as the softphone', () => {
    afterEach(cleanup)

    it('keeps the registered browser path: an enabled button, no tel: link', () => {
        useSipValue('softphone', { status: 'registered' })
        renderCallButton()

        const button = screen.getByRole('button', { name: /Позвонить/ }) as HTMLButtonElement
        expect(button.disabled).toBe(false)
        expect(button.getAttribute('title')).toBe(`Позвонить ${PHONE}`)
        expect(screen.queryByRole('link')).toBeNull()
    })

    it('keeps the unregistered browser path disabled with its existing explanation', () => {
        useSipValue('softphone', { status: 'unregistered' })
        renderCallButton()

        const button = screen.getByRole('button', { name: /Позвонить/ }) as HTMLButtonElement
        expect(button.disabled).toBe(true)
        expect(button.getAttribute('title')).toBe('SIP не зарегистрирован — переключитесь на менеджера в шапке')
        expect(screen.queryByRole('link')).toBeNull()
    })

    it('keeps the active-call path disabled with its existing explanation', () => {
        useSipValue('softphone', { status: 'registered', activeCall: { fsUuid: 'active' } })
        renderCallButton()

        const button = screen.getByRole('button', { name: /Позвонить/ }) as HTMLButtonElement
        expect(button.disabled).toBe(true)
        expect(button.getAttribute('title')).toBe('Завершите текущий звонок')
    })
})

describe('where the mode comes from', () => {
    const read = (file: string) => readFileSync(path.join(__dirname, file), 'utf8')

    it('the button reads the mode and never detects the shell for itself', () => {
        const button = read('CallButton.tsx')
        expect(button).not.toContain('isRenderedInMobileShell')
        expect(button).not.toContain('navigator.userAgent')
        expect(button).toContain('outboundMode')
    })

    it('the provider derives the mode once, after mount, and publishes it on both values', () => {
        const provider = read('../sip-client-context.tsx')
        // Hydration safety: 'softphone' is what the server renders, because it has
        // no User-Agent, and the correction happens in an effect after mount.
        expect(provider).toContain("useState<OutboundCallingMode>('softphone')")
        expect(provider).toMatch(/useEffect\(\(\) => \{\s*if \(isRenderedInMobileShellV1\(\)\) setOutboundMode\('system_dialer'\)\s*\}, \[\]\)/)
        // Calling's own context and the neutral capability read the same decision.
        expect(provider).toContain('<SipContext.Provider value={{ status, outboundMode,')
        expect(provider).toContain('<OutboundCallingClientProvider value={{ status, outboundMode,')
        // Exactly one detector call in the whole provider.
        expect(provider.match(/isRenderedInMobileShellV1\(\)/gu)?.length).toBe(1)
    })

    it('the shell User-Agent is what selects the system dialer', () => {
        // The mapping the provider applies, proven on its input.
        expect(isMobileShellUserAgentV1('Mozilla/5.0 (Linux; Android 14) YokoShell/0.1.0')).toBe(true)
        expect(isMobileShellUserAgentV1('Mozilla/5.0 (Linux; Android 14; SM-S918B) Chrome/128.0')).toBe(false)
    })
})
