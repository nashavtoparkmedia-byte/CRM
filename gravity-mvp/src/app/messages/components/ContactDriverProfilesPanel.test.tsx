import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ContactDriverProfilesPanel from './ContactDriverProfilesPanel'
import type { ContactDriverProfilePayload, ContactProfilePayload } from '@/lib/contact-profile-contract'

const parks = ['Наш Автопарк', 'YOKO', 'YOKO-2', 'YOKO-3', 'YOKO-4', 'YOKO.Доставка']
const parkCodes = ['NASH_AVTOPARK', 'YOKO', 'YOKO_2', 'YOKO_3', 'YOKO_4', 'YOKO_DELIVERY']

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
        parkCode: parkCodes[index],
        parkName,
        employmentTypeCode: 'selfemployed',
        employmentTypeLabel: 'Парковый СМЗ',
        employmentType: 'selfemployed',
        workStatus: 'working',
        currentStatus: 'offline',
        segment: 'self_employed',
        score: null,
        status: 'working',
        normalizedStatus: 'working',
        statusLabel: 'Работает',
        isMain: false,
        contactId: null,
        conflictContactId: null,
        conflictContact: null,
        linkedContactConflict: false,
        linkedContactSummary: null,
        matchedSignals: ['phone'],
        suggestionBasis: 'phone',
        suggestionBasisLabel: 'Совпадение номера телефона',
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
            { channel: 'telegram', identityId: 'identity-2', externalId: '79222155750', displayName: null, state: 'linked' },
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
            profileSourceValues: suggestions.map(item => ({
                id: item.id,
                employmentTypeCode: item.employmentTypeCode,
                workStatusCode: item.workStatus,
                currentStatusCode: item.currentStatus,
            })),
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

function linkedContact(extraProfiles: ContactDriverProfilePayload[] = []): ContactProfilePayload {
    const attached = parks.map((_, index) => profile(index, { contactId: 'contact-1', isMain: index === 0 }))
    attached.push(...extraProfiles)
    return contact({
        driverProfileState: 'LINKED',
        suggestedProfiles: [],
        suggestedDriverProfiles: [],
        attachedProfiles: attached,
        driverProfiles: attached,
        mainDriverId: attached[0].id,
        mainDriverProfile: attached[0],
        mainDriver: attached[0],
        driver: attached[0],
    })
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
    const rerenderPanel = (nextPayload: ContactProfilePayload) => rendered.rerender(
        <ContactDriverProfilesPanel
            contact={nextPayload}
            profileSyncState={options.sync || 'success'}
            profileSyncError={options.sync === 'error' ? 'network_error' : null}
            profileSyncedAt="2026-07-13T12:00:00.000Z"
            onRetry={onRetry}
            onRefetch={onRefetch}
            onOpenHelp={onOpenHelp}
        />,
    )
    return { onRetry, onRefetch, onOpenHelp, rerenderPanel, unmount: rendered.unmount }
}

function checkboxFor(profileValue: ContactDriverProfilePayload): HTMLInputElement {
    return screen.getByRole('checkbox', {
        name: `Выбрать профиль ${profileValue.fullName} — ${profileValue.parkName}`,
    }) as HTMLInputElement
}

describe('ContactDriverProfilesPanel', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        vi.stubGlobal('fetch', vi.fn())
        window.localStorage.clear()
    })

    test('shows the production-like unlinked state without fake Park/Role or technical data in the driver section', () => {
        renderPanel(contact())
        expect(screen.getByText('Профиль водителя не привязан')).toBeTruthy()
        expect(screen.getByText('Возможные профили водителя: 6')).toBeTruthy()
        expect(screen.queryByText('Парк: Яндекс')).toBeNull()
        expect(screen.queryByText('Роль: Водитель')).toBeNull()
        expect(screen.queryByTestId('technical-data')).toBeNull()
    })

    test('groups six suggestions by park and presents a correct zero-selection state', () => {
        renderPanel(contact())
        fireEvent.click(screen.getByText('Проверить профили'))

        expect(screen.getByText('Найдено 6 профилей в 6 парках')).toBeTruthy()
        expect(screen.getByText(/не будут привязаны без вашего подтверждения/)).toBeTruthy()
        expect(screen.getByText('Выберите хотя бы один профиль')).toBeTruthy()
        const attach = screen.getByRole('button', { name: 'Привязать выбранные' }) as HTMLButtonElement
        expect(attach.disabled).toBe(true)
        expect(screen.getAllByRole('checkbox')).toHaveLength(6)
        parks.forEach(park => expect(screen.getByText(park)).toBeTruthy())
    })

    test('shows singular selection wording and requires a separate confirmation', () => {
        renderPanel(contact())
        fireEvent.click(screen.getByText('Проверить профили'))
        fireEvent.click(checkboxFor(profile(0)))

        expect(screen.getByText('Выбран 1 профиль из 1 парка')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Привязать 1 профиль' }))
        expect(screen.getByTestId('attach-confirmation')).toBeTruthy()
        expect(screen.getByText(/привязать 1 профиль из 1 парка к контакту \+7 922 215-57-50/)).toBeTruthy()
        expect(fetch).not.toHaveBeenCalled()
    })

    test('selects all eligible profiles, toggles selection, and attaches only after final confirmation', async () => {
        const fetchMock = vi.mocked(fetch)
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response)
        const { onRefetch } = renderPanel(contact())
        fireEvent.click(screen.getByText('Проверить профили'))
        fireEvent.click(screen.getByText('Выбрать все'))

        expect(screen.getByText('Выбрано 6 из 6')).toBeTruthy()
        expect(screen.getByText('Выбрано 6 профилей из 6 парков')).toBeTruthy()
        expect(screen.getByText('Снять выбор')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Привязать 6 профилей' }))
        expect(fetchMock).not.toHaveBeenCalled()
        const confirmation = screen.getByTestId('attach-confirmation')
        expect(within(confirmation).getByText(/привязать 6 профилей из 6 парков к контакту \+7 922 215-57-50/)).toBeTruthy()
        parks.forEach(park => expect(within(confirmation).getByText(`• ${park}`)).toBeTruthy())

        fireEvent.click(within(confirmation).getByRole('button', { name: 'Подтвердить привязку' }))
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).driverIds).toHaveLength(6)
        await waitFor(() => expect(onRefetch).toHaveBeenCalled())
    })

    test('select all excludes a profile owned by another Contact', () => {
        const base = contact()
        const suggestions = base.suggestedProfiles.map((item, index) => index === 2 ? profile(index, {
            conflictContactId: 'contact-other',
            conflictContact: { id: 'contact-other', displayName: 'Другой водитель', chatId: 'chat-other' },
            linkedContactConflict: true,
            linkedContactSummary: { id: 'contact-other', displayName: 'Другой водитель', chatId: 'chat-other' },
        }) : item)
        renderPanel(contact({ suggestedProfiles: suggestions, suggestedDriverProfiles: suggestions }))
        fireEvent.click(screen.getByText('Проверить профили'))

        const conflicted = checkboxFor(suggestions[2])
        expect(conflicted.disabled).toBe(true)
        fireEvent.click(screen.getByText('Выбрать все'))
        expect(screen.getByText('Выбрано 5 из 5')).toBeTruthy()
        expect(conflicted.checked).toBe(false)
        expect(screen.getByText('Открыть контакт').getAttribute('href')).toContain('chat-other')
    })

    test('keeps dismissed suggestions collapsed and selectable while warning about two active profiles in one park', () => {
        const samePark = [
            profile(1, { id: 'active-1' }),
            profile(1, { id: 'active-2', fullName: 'Ремезов Александр' }),
            profile(1, {
                id: 'dismissed-1',
                fullName: 'Исторический профиль',
                status: 'dismissed',
                normalizedStatus: 'dismissed',
                statusLabel: 'Уволен',
                workStatus: 'fired',
                dismissedAt: '2026-07-01T00:00:00.000Z',
            }),
        ]
        renderPanel(contact({ suggestedProfiles: samePark, suggestedDriverProfiles: samePark }))
        fireEvent.click(screen.getByText('Проверить профили'))

        expect(screen.getByText('Найдено 3 профиля в 1 парке')).toBeTruthy()
        expect(screen.getByTestId('multiple-active-anomaly')).toBeTruthy()
        expect(screen.queryByText('Исторический профиль')).toBeNull()
        fireEvent.click(screen.getByText(/Уволенные профили: 1/))
        expect(screen.getAllByText('Исторический профиль').length).toBeGreaterThanOrEqual(1)
        expect(checkboxFor(samePark[2]).disabled).toBe(false)
        fireEvent.click(screen.getByText('Выбрать все'))
        expect(screen.getByText('Выбрано 3 из 3')).toBeTruthy()
        expect(screen.getByText('Выбрано 3 профиля из 1 парка')).toBeTruthy()
    })

    test('uses human employment labels and hides raw or unknown enums', () => {
        const suggestions = [
            profile(0, { employmentTypeCode: 'park_employee', employmentTypeLabel: 'Физлицо', employmentType: 'park_employee' }),
            profile(1, { employmentTypeCode: 'unsupported_source_value', employmentTypeLabel: 'Тип оформления не определён', employmentType: 'unsupported_source_value' }),
        ]
        renderPanel(contact({ suggestedProfiles: suggestions, suggestedDriverProfiles: suggestions }))
        fireEvent.click(screen.getByText('Проверить профили'))

        expect(screen.getByText('Физлицо')).toBeTruthy()
        expect(screen.getByText('Тип оформления не определён')).toBeTruthy()
        expect(screen.queryByText('park_employee')).toBeNull()
        expect(screen.queryByText('unsupported_source_value')).toBeNull()
    })

    test('keeps main visible while the park list is collapsed by default and preserves nested history', () => {
        const dismissed = profile(1, {
            id: 'dismissed-yoko',
            contactId: 'contact-1',
            status: 'dismissed',
            normalizedStatus: 'dismissed',
            statusLabel: 'Уволен',
            dismissedAt: '2026-07-01T00:00:00.000Z',
            fullName: 'Исторический профиль',
        })
        renderPanel(linkedContact([dismissed]))

        expect(screen.getByTestId('main-driver-profile').textContent).toContain('Наш Автопарк')
        expect(screen.getByText('Профили водителя: 7 в 6 парках')).toBeTruthy()
        expect(screen.getByText('Активных: 6 · Уволенных: 1')).toBeTruthy()
        expect(screen.queryByTestId('profiles-by-park')).toBeNull()
        expect(screen.queryByText('Исторический профиль')).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Показать профили водителя' }))
        expect(screen.getByTestId('profiles-by-park')).toBeTruthy()
        expect(screen.queryByText('Исторический профиль')).toBeNull()
        fireEvent.click(screen.getByText(/Уволенные профили: 1/))
        expect(screen.getByText('Исторический профиль')).toBeTruthy()
        expect(screen.getAllByText('Сделать главным')).toHaveLength(5)
    })

    test('preserves the expanded state across background refresh and remount', () => {
        const payload = linkedContact()
        const first = renderPanel(payload)
        fireEvent.click(screen.getByRole('button', { name: 'Показать профили водителя' }))
        expect(screen.getByTestId('profiles-by-park')).toBeTruthy()

        first.rerenderPanel({ ...payload, updatedAt: '2026-07-13T13:00:00.000Z' })
        expect(screen.getByTestId('profiles-by-park')).toBeTruthy()
        first.unmount()

        renderPanel(payload)
        expect(screen.getByTestId('profiles-by-park')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Скрыть профили водителя' })).toBeTruthy()
    })

    test('opens a CRM main-profile modal and cancel or Escape makes no request', () => {
        renderPanel(linkedContact())
        fireEvent.click(screen.getByRole('button', { name: 'Показать профили водителя' }))
        fireEvent.click(screen.getAllByText('Сделать главным')[0])

        const dialog = screen.getByRole('dialog', { name: 'Сделать профиль главным?' })
        expect(within(dialog).getByText('Главным профилем контакта станет YOKO / Парковый СМЗ.')).toBeTruthy()
        expect(within(dialog).getByText('Ремезов Александр Юрьевич')).toBeTruthy()
        expect(within(dialog).getByText('+7 922 215-57-50')).toBeTruthy()
        expect(fetch).not.toHaveBeenCalled()

        fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))
        expect(screen.queryByTestId('main-profile-confirmation')).toBeNull()
        expect(fetch).not.toHaveBeenCalled()

        fireEvent.click(screen.getAllByText('Сделать главным')[0])
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(screen.queryByTestId('main-profile-confirmation')).toBeNull()
        expect(fetch).not.toHaveBeenCalled()
    })

    test('confirms one main-profile request, shows progress, and keeps the expanded list open', async () => {
        const fetchMock = vi.mocked(fetch)
        let resolveFetch!: (response: Response) => void
        fetchMock.mockImplementation(() => new Promise<Response>(resolve => { resolveFetch = resolve }))
        const { onRefetch } = renderPanel(linkedContact())
        fireEvent.click(screen.getByRole('button', { name: 'Показать профили водителя' }))
        fireEvent.click(screen.getAllByText('Сделать главным')[0])
        const dialog = screen.getByTestId('main-profile-confirmation')
        const confirm = within(dialog).getByRole('button', { name: 'Сделать главным' })

        fireEvent.click(confirm)
        fireEvent.click(confirm)
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        expect((within(dialog).getByRole('button', { name: 'Сохраняем…' }) as HTMLButtonElement).disabled).toBe(true)
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).driverId).toBe('driver-2')

        resolveFetch({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response)
        await waitFor(() => expect(onRefetch).toHaveBeenCalled())
        await waitFor(() => expect(screen.queryByTestId('main-profile-confirmation')).toBeNull())
        expect(screen.getByTestId('profiles-by-park')).toBeTruthy()
    })

    test('keeps the main-profile modal open and displays an API error', async () => {
        const fetchMock = vi.mocked(fetch)
        fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'Профиль уже изменён' }) } as Response)
        renderPanel(linkedContact())
        fireEvent.click(screen.getByRole('button', { name: 'Показать профили водителя' }))
        fireEvent.click(screen.getAllByText('Сделать главным')[0])
        fireEvent.click(within(screen.getByTestId('main-profile-confirmation')).getByRole('button', { name: 'Сделать главным' }))

        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Профиль уже изменён'))
        expect(screen.getByTestId('main-profile-confirmation')).toBeTruthy()
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test('shows a human stale warning, hides Yandex internals, and disables retry during backoff', () => {
        const rawError = 'NASH_AVTOPARK dismissed: Yandex API 429: {"code":"429","message":"Too many requests"}'
        const payload = linkedContact()
        payload.syncState = {
            status: 'stale',
            lastSuccessfulAt: '2026-07-17T10:00:00.000Z',
            lastFailedAt: '2026-07-17T11:00:00.000Z',
            error: rawError,
            parks: [{
                parkCode: 'NASH_AVTOPARK',
                parkName: 'Наш Автопарк',
                lastSuccessfulAt: '2026-07-17T10:00:00.000Z',
                lastFailedAt: '2026-07-17T11:00:00.000Z',
                error: rawError,
                state: 'backoff',
                retryAt: '2026-07-17T11:05:00.000Z',
                canRetry: false,
            }],
        }
        payload.anomalies = [{
            type: 'sync_stale',
            severity: 'warning',
            message: rawError,
            parkName: 'Наш Автопарк',
            profileIds: [],
        }]
        const { onRetry, rerenderPanel } = renderPanel(payload)

        expect(screen.getByTestId('profile-sync-warning').textContent).toContain('Не удалось обновить данные «Наш Автопарк».')
        expect(screen.getByTestId('profile-sync-warning').textContent).toContain('Показана последняя сохранённая информация.')
        expect(screen.queryByText(/NASH_AVTOPARK|dismissed|Too many requests|code.*429/)).toBeNull()
        expect((screen.getByRole('button', { name: 'Повторить' }) as HTMLButtonElement).disabled).toBe(true)

        rerenderPanel({
            ...payload,
            syncState: {
                ...payload.syncState,
                parks: [{ ...payload.syncState.parks[0], state: 'stale', retryAt: null, canRetry: true }],
            },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
        expect(onRetry).toHaveBeenCalledWith('NASH_AVTOPARK')
    })

    test('preserves refresh, retry, and inline-help behavior', () => {
        const { unmount } = renderPanel(contact(), { sync: 'syncing' })
        expect(screen.getByText('Обновляем данные…')).toBeTruthy()
        unmount()

        const { onRetry, onOpenHelp } = renderPanel(contact(), { sync: 'error' })
        expect(screen.getByText('Не удалось обновить данные')).toBeTruthy()
        fireEvent.click(screen.getByText('Повторить'))
        expect(onRetry).toHaveBeenCalled()
        fireEvent.click(screen.getByText('Как работает раздел'))
        expect(onOpenHelp).toHaveBeenCalled()
    })
})
