import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import AddPhoneResolutionDialog from './AddPhoneResolutionDialog'

const owner = {
    id: 'owner-1',
    displayName: 'Существующий контакт',
    phone: '+79222155750',
    channels: ['max', 'whatsapp'],
    mainDriverProfile: { id: 'driver-1', fullName: 'Иванов Иван', parkName: 'YOKO' },
    driverProfileCount: 6,
    lastContactAt: '2026-07-15T08:00:00.000Z',
    chatId: 'chat-owner-1',
    isArchived: false,
}

function preflight(status: 'FREE' | 'SAME_CONTACT' | 'OTHER_CONTACT' | 'AMBIGUOUS', owners = status === 'OTHER_CONTACT' ? [owner] : []) {
    return {
        normalizedPhone: '+79222155750',
        ownershipStatus: status,
        resolutionStatus: status === 'AMBIGUOUS' ? 'PHONE_OWNERSHIP_AMBIGUOUS' : status,
        ownerContacts: owners,
        driverProfileSuggestions: status === 'FREE' || status === 'SAME_CONTACT' ? [{ id: 'driver-1' }] : [],
        searchedParks: ['Наш Автопарк', 'YOKO', 'YOKO-2', 'YOKO-3', 'YOKO-4', 'YOKO.Доставка'],
        canAdd: status === 'FREE',
        canReviewMerge: status === 'OTHER_CONTACT',
        confirmationToken: `token-${status}`,
    }
}

function response(body: unknown, ok = true, status = ok ? 200 : 409): Response {
    return { ok, status, json: async () => body } as Response
}

function renderDialog() {
    const onClose = vi.fn()
    const onResolved = vi.fn().mockResolvedValue(null)
    const onOpenContact = vi.fn()
    const onReviewMerge = vi.fn()
    render(
        <AddPhoneResolutionDialog
            contactId="contact-current"
            onClose={onClose}
            onResolved={onResolved}
            onOpenContact={onOpenContact}
            onReviewMerge={onReviewMerge}
        />,
    )
    return { onClose, onResolved, onOpenContact, onReviewMerge }
}

function enterPhone(value = '8 922 215-57-50') {
    fireEvent.change(screen.getByPlaceholderText('+7 922 215-57-50'), { target: { value } })
}

describe('AddPhoneResolutionDialog', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        vi.stubGlobal('fetch', vi.fn())
    })

    test('previews normalized input, confirms FREE, and refreshes suggestions without auto attachment', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(response(preflight('FREE')))
            .mockResolvedValueOnce(response({ action: 'added', driverProfileSuggestions: [{ id: 'driver-1' }] }))
        const { onResolved } = renderDialog()

        enterPhone()
        expect(screen.getByText('Будет сохранён: +7 922 215-57-50')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Проверить и добавить' }))
        await screen.findByText('Номер свободен и может быть добавлен.')
        expect(screen.getByText(/Проверено 6 парков/)).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Добавить номер' }))

        await screen.findByText('Номер добавлен')
        expect(screen.getByText('Возможные профили водителя: 1')).toBeTruthy()
        expect(onResolved).toHaveBeenCalledTimes(1)
        expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ method: 'POST' })
        expect(String(vi.mocked(fetch).mock.calls[1][1]?.body)).toContain('token-FREE')
    })

    test('SAME_CONTACT is idempotent and refreshes without confirm write', async () => {
        vi.mocked(fetch).mockResolvedValueOnce(response(preflight('SAME_CONTACT')))
        const { onResolved } = renderDialog()
        enterPhone('+79222155750')
        fireEvent.click(screen.getByRole('button', { name: 'Проверить и добавить' }))

        await screen.findByText('Этот номер уже добавлен к контакту')
        expect(onResolved).toHaveBeenCalledTimes(1)
        expect(fetch).toHaveBeenCalledTimes(1)
    })

    test('OTHER_CONTACT displays the owner and only opens review actions', async () => {
        vi.mocked(fetch).mockResolvedValue(response(preflight('OTHER_CONTACT')))
        const { onOpenContact, onReviewMerge } = renderDialog()
        enterPhone()
        fireEvent.click(screen.getByRole('button', { name: 'Проверить и добавить' }))

        await screen.findByText('Номер уже используется')
        expect(screen.getByText('Существующий контакт')).toBeTruthy()
        expect(screen.getByText('MAX, WhatsApp')).toBeTruthy()
        expect(screen.getByText('6')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Открыть существующий контакт' }))
        expect(onOpenContact).toHaveBeenCalledWith(owner)
        fireEvent.click(screen.getByRole('button', { name: /Проверить объединение/ }))
        expect(onReviewMerge).toHaveBeenCalledWith(owner)
        expect(String(vi.mocked(fetch).mock.calls[0][1]?.body)).toContain('preflight')
        expect(vi.mocked(fetch).mock.calls.some(call => {
            const body = JSON.parse(String(call[1]?.body || '{}'))
            return body.mode === 'confirm'
        })).toBe(false)
    })

    test('OTHER_CONTACT opens the exact owner even when it has no chat', async () => {
        const ownerWithoutChat = { ...owner, chatId: null }
        vi.mocked(fetch).mockResolvedValueOnce(response(preflight('OTHER_CONTACT', [ownerWithoutChat])))
        const { onOpenContact } = renderDialog()
        enterPhone()
        fireEvent.click(screen.getByRole('button', { name: 'Проверить и добавить' }))

        await screen.findByText('Номер уже используется')
        const openButton = screen.getByRole('button', { name: 'Открыть существующий контакт' })
        expect((openButton as HTMLButtonElement).disabled).toBe(false)
        fireEvent.click(openButton)

        expect(onOpenContact).toHaveBeenCalledWith(ownerWithoutChat)
        expect(fetch).toHaveBeenCalledTimes(1)
    })

    test('AMBIGUOUS lists every owner and never offers merge or confirm', async () => {
        const secondOwner = { ...owner, id: 'owner-2', displayName: 'Второй контакт', chatId: 'chat-owner-2' }
        vi.mocked(fetch).mockResolvedValueOnce(response(preflight('AMBIGUOUS', [owner, secondOwner])))
        renderDialog()
        enterPhone()
        fireEvent.click(screen.getByRole('button', { name: 'Проверить и добавить' }))

        await screen.findByText('Номер найден у нескольких контактов')
        expect(screen.getByText('Существующий контакт')).toBeTruthy()
        expect(screen.getByText('Второй контакт')).toBeTruthy()
        expect(screen.queryByText('PHONE_OWNERSHIP_AMBIGUOUS')).toBeNull()
        expect(screen.getByText('Ничего не добавлено. Нужна ручная проверка.')).toBeTruthy()
        expect(screen.queryByRole('button', { name: /Проверить объединение/ })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Добавить номер' })).toBeNull()
    })

    test('guards double submit while preflight is pending', async () => {
        let release: ((value: Response) => void) | undefined
        vi.mocked(fetch).mockReturnValueOnce(new Promise(resolve => { release = resolve }))
        renderDialog()
        enterPhone()
        const button = screen.getByRole('button', { name: 'Проверить и добавить' })
        fireEvent.click(button)
        fireEvent.click(button)
        expect(fetch).toHaveBeenCalledTimes(1)
        release?.(response(preflight('FREE')))
        await screen.findByText('Номер свободен и может быть добавлен.')
    })

    test('keeps API errors visible in the CRM dialog', async () => {
        vi.mocked(fetch).mockResolvedValueOnce(response({ message: 'Проверка временно недоступна' }, false, 500))
        renderDialog()
        enterPhone()
        fireEvent.click(screen.getByRole('button', { name: 'Проверить и добавить' }))
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Проверка временно недоступна'))
        expect(screen.getByTestId('add-phone-resolution-dialog')).toBeTruthy()
    })
})
