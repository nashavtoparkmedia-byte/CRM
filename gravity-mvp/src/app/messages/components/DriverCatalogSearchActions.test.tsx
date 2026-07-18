import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import DriverCatalogSearchActions from './DriverCatalogSearchActions'
import type { DriverCatalogSummary, DriverSearchResult } from '@/lib/driver-profile-search'

const catalog: DriverCatalogSummary = {
    source: 'local_nightly_sync',
    configuredParkCount: 6,
    availableParkCount: 6,
    coverage: 'complete',
    lastSuccessfulSyncAt: '2026-07-18T00:30:00.000Z',
    parks: [],
}

function result(overrides: Partial<DriverSearchResult> = {}): DriverSearchResult {
    return {
        id: 'driver-1',
        profileId: 'driver-1',
        first_name: 'Ремезов',
        last_name: 'Александр Юрьевич',
        fullName: 'Ремезов Александр Юрьевич',
        phones: ['+79222155750'],
        phone: '+79222155750',
        status: 'working',
        statusLabel: 'Работает',
        currentStatus: 'offline',
        park: { id: 'park-yoko', parkCode: 'YOKO', parkName: 'YOKO' },
        externalDriverProfileId: 'external-profile-1',
        externalParkId: 'external-park-yoko',
        yandexDriverId: 'legacy-driver-1',
        employmentType: 'selfemployed',
        employmentTypeLabel: 'Парковый СМЗ',
        lastSuccessfulSyncAt: '2026-07-18T00:30:00.000Z',
        linkedContact: null,
        contactId: null,
        isMain: false,
        anomaly: null,
        anomalies: [],
        ...overrides,
    }
}

function renderActions(onRefetch = vi.fn().mockResolvedValue(null)) {
    render(
        <DriverCatalogSearchActions
            contactId="contact-1"
            contactDisplayName="Ремезов Александр Юрьевич"
            phone="+79222155750"
            onRefetch={onRefetch}
        />,
    )
    return { onRefetch }
}

describe('DriverCatalogSearchActions', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        vi.stubGlobal('fetch', vi.fn())
    })

    test('keeps both approved local-catalog actions and checks all parks by phone', async () => {
        vi.mocked(fetch).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ drivers: [result()], total: 1, catalog }),
        } as Response)
        renderActions()

        expect(screen.getByRole('button', { name: 'Найти водителя' })).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Проверить в парках' }))

        await waitFor(() => expect(fetch).toHaveBeenCalledWith(
            '/api/drivers-search?q=%2B79222155750&limit=50',
        ))
        expect(await screen.findByText('Каталог: 6 из 6 парков', { exact: false })).toBeTruthy()
        expect(screen.getByText('Ремезов Александр Юрьевич')).toBeTruthy()
        expect(screen.getByText('YOKO · Парковый СМЗ')).toBeTruthy()
        expect(screen.getByText('ID: external-profile-1')).toBeTruthy()
    })

    test('supports manual FIO search and prevents attaching a profile owned by another Contact', async () => {
        vi.mocked(fetch).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                drivers: [result({
                    linkedContact: { id: 'contact-other', displayName: 'Другой контакт', chatId: 'chat-other' },
                    contactId: 'contact-other',
                })],
                total: 1,
                catalog,
            }),
        } as Response)
        renderActions()

        fireEvent.click(screen.getByRole('button', { name: 'Найти водителя' }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Поиск водителя' }), {
            target: { value: 'Ремезов' },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Найти' }))

        const checkbox = await screen.findByRole('checkbox', {
            name: 'Выбрать профиль Ремезов Александр Юрьевич — YOKO',
        }) as HTMLInputElement
        expect(checkbox.disabled).toBe(true)
        expect(screen.getByText('Связан с контактом «Другой контакт»')).toBeTruthy()
        expect((screen.getByRole('button', { name: 'Привязать выбранные' }) as HTMLButtonElement).disabled).toBe(true)
    })

    test('attaches only explicit operator selections through the existing safe endpoint', async () => {
        const fetchMock = vi.mocked(fetch)
        fetchMock
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ drivers: [result()], total: 1, catalog }),
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ ok: true }),
            } as Response)
        const { onRefetch } = renderActions()

        fireEvent.click(screen.getByRole('button', { name: 'Проверить в парках' }))
        const checkbox = await screen.findByRole('checkbox', {
            name: 'Выбрать профиль Ремезов Александр Юрьевич — YOKO',
        })
        fireEvent.click(checkbox)
        fireEvent.click(screen.getByRole('button', { name: 'Привязать выбранные' }))

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
        expect(fetchMock.mock.calls[1][0]).toBe('/api/contacts/contact-1/driver-profiles/attach')
        expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
            driverIds: ['driver-1'],
            selectedBy: 'operator',
        })
        await waitFor(() => expect(onRefetch).toHaveBeenCalledTimes(1))
    })
})
