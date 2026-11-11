// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const availability = vi.hoisted(() => ({ action: vi.fn() }))
vi.mock('../manual-call-actions', () => ({
    manualCallAvailabilityActionV1: availability.action,
}))

import CallButton from './CallButton'

const PHONE = '+79990000001'
const CONTACT = 'contact-1'
const AVAILABLE = {
    contract: 'calling.ManualCallAvailabilityResult.v1', status: 'available', contactId: CONTACT,
    phones: [{ phoneId: 'phone-1', phone: PHONE, preferred: true }],
}

beforeEach(() => {
    availability.action.mockReset()
    availability.action.mockResolvedValue(AVAILABLE)
})

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

const renderCallButton = async () => {
    const view = render(<CallButton contactId={CONTACT}/>)
    await waitFor(() => expect(view.container.querySelector('[data-call-unavailable]')).toBeNull())
    return view
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

    it('offers a tel: link the device can hand to its own dialer', async () => {
        useSipValue('system_dialer')
        await renderCallButton()

        const link = screen.getByRole('link', { name: /Позвонить/ })
        expect(link.getAttribute('href')).toBe(`tel:${PHONE}`)
        // A link, not a button: nothing to disable and nothing to submit.
        expect(screen.queryByRole('button')).toBeNull()
    })

    it('offers the dialer even with no softphone registration and no active call state', async () => {
        // This is the whole point: in the shell the softphone can never register,
        // so a disabled button would be the only thing an operator ever saw.
        for (const status of ['idle', 'connecting', 'unregistered', 'failed', 'disabled', 'identity-required'] as const) {
            useSipValue('system_dialer', { status })
            await renderCallButton()
            expect(screen.getByRole('link', { name: /Позвонить/ }).getAttribute('href')).toBe(`tel:${PHONE}`)
            cleanup()
        }
    })

    it('places no call itself: no originate, no microphone, no placeholder SIP state', async () => {
        const value = useSipValue('system_dialer')
        await renderCallButton()

        screen.getByRole('link', { name: /Позвонить/ }).click()

        expect(fetchSpy).not.toHaveBeenCalled()
        expect(getUserMedia).not.toHaveBeenCalled()
        expect(value.startPlaceholderOutbound).not.toHaveBeenCalled()
        expect(value.setActiveCallFsUuid).not.toHaveBeenCalled()
    })

    it('carries the number in the link and nothing else', async () => {
        useSipValue('system_dialer')
        await renderCallButton()
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

    it('keeps the registered browser path: an enabled button, no tel: link', async () => {
        useSipValue('softphone', { status: 'registered' })
        await renderCallButton()

        const button = screen.getByRole('button', { name: /Позвонить/ }) as HTMLButtonElement
        expect(button.disabled).toBe(false)
        expect(button.getAttribute('title')).toBe(`Позвонить ${PHONE}`)
        expect(screen.queryByRole('link')).toBeNull()
    })

    it('keeps the unregistered browser path disabled with its existing explanation', async () => {
        useSipValue('softphone', { status: 'unregistered' })
        await renderCallButton()

        const button = screen.getByRole('button', { name: /Позвонить/ }) as HTMLButtonElement
        expect(button.disabled).toBe(true)
        expect(button.getAttribute('title')).toBe('SIP не зарегистрирован — переключитесь на менеджера в шапке')
        expect(screen.queryByRole('link')).toBeNull()
    })

    it('keeps the active-call path disabled with its existing explanation', async () => {
        useSipValue('softphone', { status: 'registered', activeCall: { fsUuid: 'active' } })
        await renderCallButton()

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

describe('P1: the button offers a call only when Calling allows it', () => {
    let fetchSpy: ReturnType<typeof vi.fn>

    beforeEach(() => {
        fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true, callId: 'manual_1', fsUuid: 'uuid-1', replay: false }), { status: 200 }))
        vi.stubGlobal('fetch', fetchSpy)
        Object.defineProperty(globalThis.navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) },
        })
    })

    afterEach(() => {
        cleanup()
        vi.unstubAllGlobals()
    })

    it.each(['softphone', 'system_dialer'] as const)('a deprecated raw phoneNumber gets a disabled button, no tel: link and no request (%s)', mode => {
        useSipValue(mode)
        render(<CallButton phoneNumber={PHONE}/>)
        const button = screen.getByRole('button', { name: /Позвонить/ }) as HTMLButtonElement
        expect(button.disabled).toBe(true)
        expect(button.getAttribute('title')).toBe('Звонок отсюда недоступен — позвоните из карточки человека')
        expect(screen.queryByRole('link')).toBeNull()
        expect(availability.action).not.toHaveBeenCalled()
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it.each([
        ['voice_denied', 'Звонки этому человеку запрещены'],
        ['all_denied', 'Связь с этим человеком запрещена'],
        ['staff_not_authenticated', 'Войдите по паролю, чтобы звонить'],
        ['no_verified_number', 'Нет проверенного номера этого контакта'],
    ])('when Calling refuses (%s) nothing is offered, not even on the system dialer', async (reason, title) => {
        availability.action.mockResolvedValue({ contract: 'calling.ManualCallAvailabilityResult.v1', status: 'unavailable', reason })
        for (const mode of ['softphone', 'system_dialer'] as const) {
            useSipValue(mode)
            render(<CallButton contactId={CONTACT}/>)
            await waitFor(() => expect(screen.getByRole('button', { name: /Позвонить/ }).getAttribute('data-call-unavailable')).toBe(reason))
            expect((screen.getByRole('button', { name: /Позвонить/ }) as HTMLButtonElement).disabled).toBe(true)
            expect(screen.getByRole('button', { name: /Позвонить/ }).getAttribute('title')).toBe(title)
            expect(screen.queryByRole('link')).toBeNull()
            cleanup()
        }
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('asks availability for the Contact only, never with a number', async () => {
        useSipValue('softphone')
        await renderCallButton()
        expect(availability.action).toHaveBeenCalledWith({ contract: 'calling.ManualCallAvailabilityQuery.v1', contactId: CONTACT })
    })

    it('starts the call with the requestId, the Contact and its phone id — no phone number in the body', async () => {
        const value = useSipValue('softphone')
        await renderCallButton()
        fireEvent.click(screen.getByRole('button', { name: /Позвонить/ }))
        await waitFor(() => expect(value.setActiveCallFsUuid).toHaveBeenCalledWith('uuid-1'))
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('/api/calls/originate')
        const sent = JSON.parse(String(init.body))
        expect(Object.keys(sent).sort()).toEqual(['contactId', 'phoneId', 'requestId'])
        expect(sent).toMatchObject({ contactId: CONTACT, phoneId: 'phone-1' })
        expect(String(init.body)).not.toContain(PHONE)
    })

    it('a second press is a new intent with a new requestId; a press while busy sends nothing', async () => {
        let release: () => void = () => {}
        fetchSpy.mockImplementationOnce(() => new Promise<Response>(resolve => {
            release = () => resolve(new Response(JSON.stringify({ ok: true, fsUuid: 'uuid-1' }), { status: 200 }))
        }))
        useSipValue('softphone')
        await renderCallButton()
        const button = screen.getByRole('button', { name: /Позвонить/ }) as HTMLButtonElement
        fireEvent.click(button)
        fireEvent.click(button)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        release()
        await waitFor(() => expect(button.disabled).toBe(false))
        fireEvent.click(button)
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
        const ids = fetchSpy.mock.calls.map(call => JSON.parse(String((call[1] as RequestInit).body)).requestId)
        expect(ids[0]).not.toBe(ids[1])
    })

    it('an indeterminate outcome tells the employee there will be no redial', async () => {
        fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, status: 'indeterminate', callId: 'manual_1' }), { status: 202 }))
        const value = useSipValue('softphone')
        await renderCallButton()
        fireEvent.click(screen.getByRole('button', { name: /Позвонить/ }))
        await waitFor(() => expect(value.cancelPlaceholderOutbound).toHaveBeenCalled())
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
})
