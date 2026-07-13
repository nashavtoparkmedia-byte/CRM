import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import ContactDriverProfilesPanel from './ContactDriverProfilesPanel'
import type { ContactDriverProfilePayload, ContactProfilePayload } from '@/lib/contact-profile-contract'

const parks = ['Наш Автопарк', 'YOKO', 'YOKO-2', 'YOKO-3', 'YOKO-4', 'YOKO.Доставка']

function profile(index: number, overrides: Partial<ContactDriverProfilePayload> = {}): ContactDriverProfilePayload {
    const parkName = parks[index]
    return {
        id: `driver-${index + 1}`,
        yandexDriverId: `legacy-${index + 1}`,
        externalDriverProfileId: `external-${index + 1}`,
        externalParkId: `external-park-${index + 1}`,
        fullName: 'Ремезов Александр Юрьевич',
        phone: '+79222155750',
        lastExternalPark: parkName,
        parkCode: `PARK_${index + 1}`,
        parkName,
        employmentType: 'Самозанятый',
        workStatus: 'working',
        currentStatus: 'working',
        segment: 'self_employed',
        score: null,
        status: 'working',
        isMain: false,
        contactId: null,
        conflictContactId: null,
        conflictContact: null,
        matchedSignals: ['phone'],
        personResolutionStatus: 'unlinked',
        personResolutionBasis: null,
        externalPersonKey: null,
        lastOrderAt: null,
        hiredAt: null,
        dismissedAt: null,
        sourceUpdatedAt: '2026-07-13T12:00:00.000Z',
        lastSuccessfulSyncAt: '2026-07-13T12:00:00.000Z',
        lastFailedSyncAt: null,
        ...overrides,
    }
}

function contact(overrides: Partial<ContactProfilePayload> = {}): ContactProfilePayload {
    const suggestions = parks.map((_, index) => profile(index))
    return {
        id: 'contact-1',
        displayName: '+79222155750',
        displayNameSource: 'channel',
        masterSource: 'chat',
        yandexDriverId: null,
        mainDriverId: null,
        mainDriverSelection: 'auto',
        primaryPhoneId: 'phone-1',
        primaryPhone: { id: 'phone-1', phone: '+79222155750', label: null, isPrimary: true, source: 'max' },
        notes: null,
        tags: [],
        customFields: {},
        isArchived: false,
        createdAt: '2026-07-13T12:00:00.000Z',
        updatedAt: '2026-07-13T12:00:00.000Z',
        phones: [{ id: 'phone-1', phone: '+79222155750', label: null, isPrimary: true, source: 'max' }],
        identities: [],
        chats: [],
        channels: [
            { channel: 'max', identityId: 'identity-1', externalId: '902144614300', displayName: null, state: 'linked' },
            { channel: 'whatsapp', identityId: null, externalId: null, displayName: null, state: 'available_by_phone' },
            { channel: 'telegram', identityId: null, externalId: null, displayName: null, state: 'available_by_phone' },
        ],
        driverProfileState: 'UNLINKED_WITH_SUGGESTIONS',
        suggestedProfiles: suggestions,
        attachedProfiles: [],
        mainDriverProfile: null,
        syncState: { status: 'never', lastSuccessfulAt: null, lastFailedAt: null, error: null, parks: [] },
        anomalies: [],
        technicalData: {
            contactId: 'contact-1',
            providerIds: [{ channel: 'max', externalId: '902144614300' }],
            driverProfileIds: [],
            suggestedProfileIds: suggestions.map(item => item.id),
            resolutionState: 'UNLINKED_WITH_SUGGESTIONS',
            lastSuccessfulSyncAt: null,
            lastFailedSyncAt: null,
        },
        driver: null,
        mainDriver: null,
        driverProfiles: [],
        profileAnomalies: [],
        suggestedDriverProfiles: suggestions,
        mergeHistory: [],
        ...overrides,
    }
}

function renderPanel(payload: ContactProfilePayload, options: { sync?: 'idle' | 'syncing' | 'success' | 'error' } = {}) {
    const onRetry = vi.fn()
    const onRefetch = vi.fn().mockResolvedValue(null)
    const onOpenHelp = vi.fn()
    const rendered = render(
        <ContactDriverProfilesPanel
            contact={payload}
            profileSyncState={options.sync || 'success'}
            profileSyncError={options.sync === 'error' ? 'network_error' : null}
            profileSyncedAt="2026-07-13T12:00:00.000Z"
            onRetry={onRetry}
            onRefetch={onRefetch}
            onOpenHelp={onOpenHelp}
        />,
    )
    return { onRetry, onRefetch, onOpenHelp, unmount: rendered.unmount }
}

describe('ContactDriverProfilesPanel', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        vi.stubGlobal('fetch', vi.fn())
        vi.spyOn(window, 'confirm').mockReturnValue(true)
    })

    test('shows the production-like unlinked state with six suggestions and no fake Park/Role', () => {
        renderPanel(contact())
        expect(screen.getByText('Профиль водителя не привязан')).toBeTruthy()
        expect(screen.getByText('Возможные профили водителя: 6')).toBeTruthy()
        expect(screen.getByText('Проверить профили')).toBeTruthy()
        expect(screen.queryByText('Парк: Яндекс')).toBeNull()
        expect(screen.queryByText('Роль: Водитель')).toBeNull()
        expect((screen.getByTestId('technical-data') as HTMLDetailsElement).open).toBe(false)
    })

    test('opens a six-park review, selects all, and attaches only after explicit confirmation', async () => {
        const fetchMock = vi.mocked(fetch)
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response)
        const { onRefetch } = renderPanel(contact())

        fireEvent.click(screen.getByText('Проверить профили'))
        expect(screen.getByTestId('suggested-profile-review')).toBeTruthy()
        expect(screen.getAllByRole('checkbox')).toHaveLength(6)
        parks.forEach(park => expect(screen.getByRole('checkbox', { name: `Выбрать ${park}` })).toBeTruthy())
        expect(fetchMock).not.toHaveBeenCalled()

        fireEvent.click(screen.getByText('Выбрать все'))
        expect(screen.getByText('Вы собираетесь привязать 6 профилей из 6 парков к контакту. Проверьте, что это один человек.')).toBeTruthy()
        fireEvent.click(screen.getByText('Привязать выбранные'))

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).driverIds).toHaveLength(6)
        await waitFor(() => expect(onRefetch).toHaveBeenCalled())
    })

    test('disables a profile owned by another Contact and exposes the existing chat', () => {
        const suggestions = contact().suggestedProfiles.map((item, index) => index === 2 ? profile(index, {
            conflictContactId: 'contact-other',
            conflictContact: { id: 'contact-other', displayName: 'Другой водитель', chatId: 'chat-other' },
        }) : item)
        renderPanel(contact({ suggestedProfiles: suggestions, suggestedDriverProfiles: suggestions }))
        fireEvent.click(screen.getByText('Проверить профили'))

        const conflicted = screen.getByRole('checkbox', { name: 'Выбрать YOKO-2' }) as HTMLInputElement
        expect(conflicted.disabled).toBe(true)
        expect(screen.getByText(/Профиль принадлежит контакту/)).toBeTruthy()
        expect(screen.getByText('Открыть контакт').getAttribute('href')).toContain('chat-other')
    })

    test('renders profiles by park, keeps dismissed profiles collapsed, and supports manual main selection', async () => {
        const attached = parks.map((_, index) => profile(index, { contactId: 'contact-1', isMain: index === 0 }))
        attached.push(profile(1, {
            id: 'dismissed-yoko',
            contactId: 'contact-1',
            status: 'dismissed',
            dismissedAt: '2026-07-01T00:00:00.000Z',
            fullName: 'Исторический профиль',
        }))
        const payload = contact({
            driverProfileState: 'LINKED',
            suggestedProfiles: [],
            suggestedDriverProfiles: [],
            attachedProfiles: attached,
            driverProfiles: attached,
            mainDriverId: attached[0].id,
            mainDriverProfile: attached[0],
            mainDriver: attached[0],
            driver: attached[0],
            technicalData: {
                ...contact().technicalData,
                driverProfileIds: attached.map(item => item.id),
                suggestedProfileIds: [],
                resolutionState: 'LINKED',
            },
        })
        const fetchMock = vi.mocked(fetch)
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response)
        renderPanel(payload)

        expect(screen.getByTestId('main-driver-profile').textContent).toContain('Наш Автопарк')
        parks.forEach(park => expect(screen.getByTestId('profiles-by-park').textContent).toContain(park))
        expect(screen.queryByText('Исторический профиль')).toBeNull()
        fireEvent.click(screen.getByText(/Уволенные профили: 1/))
        expect(screen.getByText('Исторический профиль')).toBeTruthy()

        fireEvent.click(screen.getAllByText('Сделать главным')[0])
        await waitFor(() => expect(fetchMock).toHaveBeenCalled())
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).driverId).toBe('driver-2')
    })

    test('shows refresh states, retry, inline help, and closed technical data', () => {
        const { unmount } = renderPanel(contact(), { sync: 'syncing' })
        expect(screen.getByText('Обновляем данные…')).toBeTruthy()
        unmount()

        const { onRetry, onOpenHelp } = renderPanel(contact(), { sync: 'error' })
        expect(screen.getByText('Не удалось обновить данные')).toBeTruthy()
        fireEvent.click(screen.getByText('Повторить'))
        expect(onRetry).toHaveBeenCalled()
        fireEvent.click(screen.getByText('Как работает раздел'))
        expect(onOpenHelp).toHaveBeenCalled()
        expect((screen.getByTestId('technical-data') as HTMLDetailsElement).open).toBe(false)
    })
})
