import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * «Настройки → Интеграции → MAX → Личный аккаунт».
 *
 * The heading counts the personal accounts that are really connected: none
 * until the scraper reports a signed-in session, so an offline scraper or a
 * pending QR never reads as one connected account.
 */

vi.mock('../../../max-actions', () => ({
    addMaxConnection: vi.fn(),
    disconnectMax: vi.fn(),
    updateMaxConnectionSettings: vi.fn(),
    pauseMaxConnection: vi.fn(),
    resumeMaxConnection: vi.fn(),
    deleteMaxMessages: vi.fn(),
}))
vi.mock('@/modules/messaging/public/v1/client-ui/channel-sync-block', () => ({
    default: () => null,
}))

import MaxLoginClient from './MaxLoginClient'

const fetchMock = vi.fn()

function scraperStatus(body: Record<string, unknown>) {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function openPersonalTab() {
    render(<MaxLoginClient initialConnections={[]} />)
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Личный аккаунт/ }), { button: 0 })
}

describe('MAX personal account count', () => {
    beforeEach(() => {
        fetchMock.mockReset()
        vi.stubGlobal('fetch', fetchMock)
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
        cleanup()
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('reads zero while the scraper is offline', async () => {
        fetchMock.mockRejectedValue(new TypeError('fetch failed'))
        openPersonalTab()

        expect(await screen.findByText('Скрейпер не запущен')).toBeTruthy()
        expect(screen.getByRole('heading', { name: 'Подключенные аккаунты (0)' })).toBeTruthy()
        expect(screen.queryByText('Подключенные аккаунты (1)')).toBeNull()
    })

    it('reads zero while the scraper waits for a QR scan', async () => {
        fetchMock.mockResolvedValue(scraperStatus({ isLoggedIn: false, qrUpdatedAt: 1 }))
        openPersonalTab()

        expect(await screen.findByAltText('MAX QR Code')).toBeTruthy()
        expect(screen.getByRole('heading', { name: 'Подключенные аккаунты (0)' })).toBeTruthy()
    })

    it('reads one once the scraper reports a signed-in account', async () => {
        fetchMock.mockResolvedValue(scraperStatus({ isLoggedIn: true }))
        openPersonalTab()

        expect(await screen.findByRole('heading', { name: 'Подключенные аккаунты (1)' })).toBeTruthy()
        expect(screen.getByText('Подключено')).toBeTruthy()
    })
})
