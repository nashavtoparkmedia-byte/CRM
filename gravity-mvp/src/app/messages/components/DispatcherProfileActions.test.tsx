import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import DispatcherProfileActions from './DispatcherProfileActions'
import type { YandexDispatcherTarget } from '@/lib/driver-profiles/dispatcher-links'

function target(overrides: Partial<YandexDispatcherTarget> = {}): YandexDispatcherTarget {
    return {
        mode: 'deep_link',
        url: 'https://fleet.yandex.ru/map/drivers/profile-1?park_id=park-1',
        parkRootUrl: 'https://fleet.yandex.ru/contractors?park_id=park-1',
        parkCode: 'YOKO',
        parkName: 'YOKO',
        externalParkId: 'park-1',
        externalDriverProfileId: 'profile-1',
        phone: '+79222155750',
        reason: 'ready',
        ...overrides,
    }
}

describe('DispatcherProfileActions', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)

    beforeEach(() => {
        vi.clearAllMocks()
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText },
        })
    })

    test('opens the proven deep link and exposes copy actions for fallback data', async () => {
        render(<DispatcherProfileActions target={target()} />)

        expect(screen.getByRole('link', { name: 'Диспетчерская' }).getAttribute('href'))
            .toBe('https://fleet.yandex.ru/map/drivers/profile-1?park_id=park-1')
        fireEvent.click(screen.getByRole('button', { name: 'Скопировать внешний ID профиля' }))
        fireEvent.click(screen.getByRole('button', { name: 'Скопировать телефон водителя' }))

        await waitFor(() => expect(writeText).toHaveBeenNthCalledWith(1, 'profile-1'))
        expect(writeText).toHaveBeenNthCalledWith(2, '+79222155750')
    })

    test('uses the park-list fallback when the direct profile route is unavailable', () => {
        render(<DispatcherProfileActions target={target({
            mode: 'fallback',
            url: 'https://fleet.yandex.ru/contractors?park_id=park-1',
            externalDriverProfileId: null,
            reason: 'missing_profile_id',
        })} />)

        expect(screen.getByRole('link', { name: 'Открыть парк' }).getAttribute('href'))
            .toBe('https://fleet.yandex.ru/contractors?park_id=park-1')
        expect(screen.queryByRole('button', { name: 'Скопировать внешний ID профиля' })).toBeNull()
        expect(screen.getByRole('button', { name: 'Скопировать телефон водителя' })).toBeTruthy()
    })
})
