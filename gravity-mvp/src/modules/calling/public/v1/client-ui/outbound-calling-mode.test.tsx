// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    OutboundCallingClientProvider,
    type OutboundCallingClientCapability,
    type OutboundCallingMode,
} from '@/infrastructure/ui/calling-client-capability'
import DriverCallButton from '@/modules/fleet-operations/internal/client-ui/DriverCallButton'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isMobileShellUserAgentV1 } from './mobile-shell-client'

/**
 * One outbound behaviour, two buttons.
 *
 * Calling's CallButton and Fleet's DriverCallButton are one implementation
 * separated only by the capability seam, and `check-calling-client-ui-boundary`
 * asserts that byte-for-byte. These tests assert the behaviour the seam carries:
 * the same number, offered the same way, on whichever client the operator is on.
 *
 * Fleet's button is the one exercised here because it reads the neutral
 * capability directly, so the mode can be supplied without standing up a SIP
 * stack. The twin assertion is what makes a proof about this button a proof
 * about Calling's too - and it is asserted, not assumed, below.
 */

const PHONE = '+79990000001'

function capability(overrides: Partial<OutboundCallingClientCapability> = {}): OutboundCallingClientCapability {
    return {
        status: 'registered',
        outboundMode: 'softphone',
        hasActiveCall: false,
        startPlaceholderOutbound: vi.fn(),
        cancelPlaceholderOutbound: vi.fn(),
        setActiveCallFsUuid: vi.fn(),
        ...overrides,
    }
}

function renderDriverButton(value: OutboundCallingClientCapability) {
    return render(
        <OutboundCallingClientProvider value={value}>
            <DriverCallButton phoneNumber={PHONE}/>
        </OutboundCallingClientProvider>,
    )
}

const mode = (outboundMode: OutboundCallingMode, overrides: Partial<OutboundCallingClientCapability> = {}) =>
    capability({ outboundMode, ...overrides })

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
        renderDriverButton(mode('system_dialer'))

        const link = screen.getByRole('link', { name: /Позвонить/ })
        expect(link.getAttribute('href')).toBe(`tel:${PHONE}`)
        // A link, not a button: nothing to disable and nothing to submit.
        expect(screen.queryByRole('button')).toBeNull()
    })

    it('offers the dialer even with no softphone registration and no active call state', () => {
        // This is the whole point: in the shell the softphone can never register,
        // so a disabled button would be the only thing an operator ever saw.
        for (const status of ['idle', 'connecting', 'unregistered', 'failed', 'disabled', 'identity-required'] as const) {
            renderDriverButton(mode('system_dialer', { status }))
            expect(screen.getByRole('link', { name: /Позвонить/ }).getAttribute('href')).toBe(`tel:${PHONE}`)
            cleanup()
        }
    })

    it('places no call itself: no originate, no microphone, no placeholder SIP state', () => {
        const value = mode('system_dialer')
        renderDriverButton(value)

        screen.getByRole('link', { name: /Позвонить/ }).click()

        expect(fetchSpy).not.toHaveBeenCalled()
        expect(getUserMedia).not.toHaveBeenCalled()
        expect(value.startPlaceholderOutbound).not.toHaveBeenCalled()
        expect(value.setActiveCallFsUuid).not.toHaveBeenCalled()
    })

    it('carries the number in the link and nothing else', () => {
        renderDriverButton(mode('system_dialer'))
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
        renderDriverButton(mode('softphone', { status: 'registered' }))

        const button = screen.getByRole('button', { name: /Позвонить/ }) as HTMLButtonElement
        expect(button.disabled).toBe(false)
        expect(button.getAttribute('title')).toBe(`Позвонить ${PHONE}`)
        expect(screen.queryByRole('link')).toBeNull()
    })

    it('keeps the unregistered browser path disabled with its existing explanation', () => {
        renderDriverButton(mode('softphone', { status: 'unregistered' }))

        const button = screen.getByRole('button', { name: /Позвонить/ }) as HTMLButtonElement
        expect(button.disabled).toBe(true)
        expect(button.getAttribute('title')).toBe('SIP не зарегистрирован — переключитесь на менеджера в шапке')
        expect(screen.queryByRole('link')).toBeNull()
    })

    it('keeps the active-call path disabled with its existing explanation', () => {
        renderDriverButton(mode('softphone', { status: 'registered', hasActiveCall: true }))

        const button = screen.getByRole('button', { name: /Позвонить/ }) as HTMLButtonElement
        expect(button.disabled).toBe(true)
        expect(button.getAttribute('title')).toBe('Завершите текущий звонок')
    })
})

describe('the seam that makes one proof cover both buttons', () => {
    const read = (relative: string) =>
        readFileSync(path.resolve(__dirname, '../../../../../..', relative), 'utf8')

    const CALLING = 'src/modules/calling/public/v1/client-ui/CallButton.tsx'
    const FLEET = 'src/modules/fleet-operations/internal/client-ui/DriverCallButton.tsx'

    it('Fleet’s button is Calling’s button, modulo the capability seam', () => {
        // The same substitution check-calling-client-ui-boundary performs. Asserted
        // here too so the behavioural proofs above, which drive Fleet’s button,
        // are proofs about Calling’s button as well rather than by analogy.
        const transformed = read(FLEET)
            .replace(
                "import { useOutboundCallingClient } from '@/infrastructure/ui/calling-client-capability'",
                "import { useSip } from '@/modules/calling/public/v1/sip-client-context'",
            )
            .replace(
                'const { status, hasActiveCall: activeCall, outboundMode, startPlaceholderOutbound, cancelPlaceholderOutbound, setActiveCallFsUuid } = useOutboundCallingClient()',
                'const { status, activeCall, outboundMode, startPlaceholderOutbound, cancelPlaceholderOutbound, setActiveCallFsUuid } = useSip()',
            )
        expect(transformed).toBe(read(CALLING))
    })

    it('Fleet learns the mode and never the platform', () => {
        const fleet = read(FLEET)
        // No reach into Calling, and no second copy of the shell token: Fleet is
        // told how outbound calling is presented, not what it is running inside.
        expect(fleet).not.toContain('@/modules/calling/')
        expect(fleet).not.toContain('YokoShell/')
        expect(fleet).not.toContain('isRenderedInMobileShell')
        expect(fleet).toContain("from '@/infrastructure/ui/calling-client-capability'")
    })

    it('neither button detects the shell for itself', () => {
        for (const file of [CALLING, FLEET]) {
            expect(read(file)).not.toContain('isRenderedInMobileShell')
            expect(read(file)).not.toContain('navigator.userAgent')
        }
    })

    it('the provider derives the mode once, after mount, and publishes it on both values', () => {
        const provider = read('src/modules/calling/public/v1/sip-client-context.tsx')
        // Hydration safety: 'softphone' is what the server renders, because it has
        // no User-Agent, and the correction happens in an effect after mount.
        expect(provider).toContain("useState<OutboundCallingMode>('softphone')")
        expect(provider).toMatch(/useEffect\(\(\) => \{\s*if \(isRenderedInMobileShellV1\(\)\) setOutboundMode\('system_dialer'\)\s*\}, \[\]\)/)
        // Both consumers read the same decision.
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
