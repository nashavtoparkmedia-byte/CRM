// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    OutboundCallingClientProvider,
    type OutboundCallingClientCapability,
    type OutboundCallingMode,
} from '@/infrastructure/ui/calling-client-capability'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import DriverCallButton from './DriverCallButton'

/**
 * Fleet's driver-card call button, driven through the neutral capability seam.
 *
 * Fleet is told how outbound calling is presented and nothing about the client
 * it runs in, so the mode is supplied here exactly as Calling's provider would
 * supply it. `check-calling-client-ui-boundary` separately proves this button
 * is Calling's button modulo the seam.
 */

const PHONE = '+79990000001'

function capability(outboundMode: OutboundCallingMode, overrides: Partial<OutboundCallingClientCapability> = {}): OutboundCallingClientCapability {
    return {
        status: 'registered',
        outboundMode,
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
        renderDriverButton(capability('system_dialer'))

        const link = screen.getByRole('link', { name: /Позвонить/ })
        expect(link.getAttribute('href')).toBe(`tel:${PHONE}`)
        expect(screen.queryByRole('button')).toBeNull()
    })

    it('offers the dialer even with no softphone registration and no active call state', () => {
        for (const status of ['idle', 'connecting', 'unregistered', 'failed', 'disabled', 'identity-required'] as const) {
            renderDriverButton(capability('system_dialer', { status }))
            expect(screen.getByRole('link', { name: /Позвонить/ }).getAttribute('href')).toBe(`tel:${PHONE}`)
            cleanup()
        }
    })

    it('places no call itself: no originate, no microphone, no placeholder SIP state', () => {
        const value = capability('system_dialer')
        renderDriverButton(value)

        screen.getByRole('link', { name: /Позвонить/ }).click()

        expect(fetchSpy).not.toHaveBeenCalled()
        expect(getUserMedia).not.toHaveBeenCalled()
        expect(value.startPlaceholderOutbound).not.toHaveBeenCalled()
        expect(value.setActiveCallFsUuid).not.toHaveBeenCalled()
    })

    it('carries the number in the link and nothing else', () => {
        renderDriverButton(capability('system_dialer'))
        const link = screen.getByRole('link', { name: /Позвонить/ })
        expect(link.getAttribute('href')).toBe(`tel:${PHONE}`)
        expect(link.getAttribute('target')).toBeNull()
        expect(link.getAttribute('download')).toBeNull()
    })
})

describe('outbound calling presented as the softphone', () => {
    afterEach(cleanup)

    it('keeps the registered browser path: an enabled button, no tel: link', () => {
        renderDriverButton(capability('softphone', { status: 'registered' }))

        const button = screen.getByRole('button', { name: /Позвонить/ }) as HTMLButtonElement
        expect(button.disabled).toBe(false)
        expect(button.getAttribute('title')).toBe(`Позвонить ${PHONE}`)
        expect(screen.queryByRole('link')).toBeNull()
    })

    it('keeps the unregistered browser path disabled with its existing explanation', () => {
        renderDriverButton(capability('softphone', { status: 'unregistered' }))

        const button = screen.getByRole('button', { name: /Позвонить/ }) as HTMLButtonElement
        expect(button.disabled).toBe(true)
        expect(button.getAttribute('title')).toBe('SIP не зарегистрирован — переключитесь на менеджера в шапке')
        expect(screen.queryByRole('link')).toBeNull()
    })

    it('keeps the active-call path disabled with its existing explanation', () => {
        renderDriverButton(capability('softphone', { status: 'registered', hasActiveCall: true }))

        const button = screen.getByRole('button', { name: /Позвонить/ }) as HTMLButtonElement
        expect(button.disabled).toBe(true)
        expect(button.getAttribute('title')).toBe('Завершите текущий звонок')
    })
})

describe('Fleet learns the mode and never the platform', () => {
    it('depends on the neutral seam only, with no reach into Calling and no shell token', () => {
        const button = readFileSync(path.join(__dirname, 'DriverCallButton.tsx'), 'utf8')
        expect(button).toContain("from '@/infrastructure/ui/calling-client-capability'")
        expect(button).not.toContain('@/modules/calling/')
        expect(button).not.toContain('YokoShell/')
        expect(button).not.toContain('isRenderedInMobileShell')
        expect(button).not.toContain('navigator.userAgent')
    })
})
