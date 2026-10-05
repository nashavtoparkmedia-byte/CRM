import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import BotPageClient from './BotPageClient'
import { deleteBotUserMutation } from './bot-user-mutations'

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('Telegram bot user mutations', () => {
    it.each([
        { action: 'unlink' as const, telegramId: '42' },
        { action: 'dismiss' as const, requestId: 'request-1' },
    ])('rejects a failed $action response instead of reporting local success', async mutation => {
        const request = vi.fn().mockResolvedValue({
            ok: false,
            json: vi.fn().mockResolvedValue({ error: 'Forbidden' }),
        })
        vi.stubGlobal('fetch', request)

        await expect(deleteBotUserMutation(mutation)).rejects.toThrow('Forbidden')
        expect(request).toHaveBeenCalledWith('/api/bot-users', expect.objectContaining({
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mutation),
        }))
    })

    it('resolves only after a successful server mutation', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

        await expect(deleteBotUserMutation({ action: 'unlink', telegramId: '42' })).resolves.toBeUndefined()
    })
})

// Operator flow of the Drivers tab. Rendered without JSX so the page keeps one
// test file; every fixture is synthetic.
describe('Drivers tab: explicit person confirmation before a Telegram link', () => {
    type Call = { url: string; method: string; body: Record<string, unknown> | null }
    type Reply = [number, unknown]

    const request = {
        id: 'req-1',
        telegramId: '700000001',
        phone: null,
        username: 'synthetic_driver',
        firstName: 'Тест',
        lastName: null,
        chatId: 'chat-1',
        chatContactId: 'contact-t',
        createdAt: '2026-10-01T10:00:00.000Z',
    }
    const driver = {
        id: 'drv-1',
        yandexDriverId: 'yp-1',
        fullName: 'Тестова Анна Сергеевна',
        phone: '+79990000001',
        parkId: 'park-1',
        parkName: 'Тестпарк',
        workStatus: 'working',
        currentStatus: 'free',
        source: 'yandex',
        profileClusterKey: 'vu:7700000001',
        personContactId: null as string | null,
        personReviewRequired: false,
    }

    function stubServer(reply: (call: Call, calls: Call[]) => Reply | Promise<Reply>) {
        const calls: Call[] = []
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            const call = {
                url,
                method: init?.method ?? 'GET',
                body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
            }
            calls.push(call)
            const [status, payload] = await reply(call, calls)
            return { ok: status >= 200 && status < 300, status, json: async () => payload }
        }))
        return calls
    }

    const isSearch = (c: Call) => c.url === '/api/bot-link' && c.body?.action === 'search'
    const isLink = (c: Call) => c.url === '/api/bot-link' && c.body?.action === 'link'
    const isConfirm = (c: Call) => c.url === '/api/contacts/contact-t/driver-person'
    const isDismiss = (c: Call) => c.url === '/api/bot-users' && c.method === 'DELETE'

    // The refresh search after a confirmation briefly disables the actions; click
    // only once the button is live, as an operator would.
    async function clickWhenEnabled(name: string) {
        const button = await screen.findByRole('button', { name }, { timeout: 3000 }) as HTMLButtonElement
        await waitFor(() => expect(button.disabled).toBe(false), { timeout: 3000 })
        fireEvent.click(button)
    }

    async function openSearch(requestRow: { username: string } = request) {
        render(createElement(BotPageClient, { iframeSrc: 'about:blank' }))
        fireEvent.click(screen.getByText('Водители'))
        await screen.findByText(`@${requestRow.username}`)
        fireEvent.click(screen.getByRole('button', { name: 'Привязать' }))
        fireEvent.change(screen.getByPlaceholderText('Телефон или имя водителя...'), { target: { value: 'Тестова Анна' } })
        await screen.findByText(driver.fullName)
    }

    afterEach(() => {
        cleanup()
    })

    it('confirms through Contacts as a separate visible action, refreshes, then links', async () => {
        let confirmed = false
        const calls = stubServer(call => {
            if (call.url === '/api/bot-users' && call.method === 'GET') return [200, { linked: [], requests: confirmed && calls.some(isDismiss) ? [] : [request] }]
            if (isSearch(call)) return [200, { drivers: [{ ...driver, personContactId: confirmed ? 'contact-t' : null }], checkedParks: 6, errors: [] }]
            if (isLink(call)) return confirmed
                ? [200, { success: true, driverName: driver.fullName }]
                : [409, { code: 'PERSON_CONFIRMATION_REQUIRED', error: 'Сначала подтвердите, что этот профиль водителя относится к этому человеку.' }]
            if (isConfirm(call)) { confirmed = true; return [200, { confirmation: { status: 'confirmed', contactId: 'contact-t' } }] }
            if (isDismiss(call)) return [200, {}]
            return [404, {}]
        })
        await openSearch()

        fireEvent.click(screen.getByRole('button', { name: 'Привязать' }))
        await screen.findByText('Перед привязкой Telegram необходимо подтвердить, что этот профиль водителя относится к этому человеку.')
        // The refused link wrote nothing and left the request in the queue.
        expect(calls.filter(isConfirm)).toHaveLength(0)
        expect(calls.filter(isDismiss)).toHaveLength(0)

        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить водителя' }))
        await screen.findByText('Водитель подтверждён.')
        expect(calls.filter(isConfirm)[0].body).toEqual({
            profileClusterKey: 'vu:7700000001',
            representativeDriverId: 'drv-1',
            searchInput: 'Тестова Анна',
        })
        // Authoritative refresh: the driver search ran again after the confirmation.
        await waitFor(() => expect(calls.filter(isSearch).length).toBeGreaterThanOrEqual(2), { timeout: 3000 })

        await clickWhenEnabled('Привязать Telegram')
        await waitFor(() => expect(calls.filter(isDismiss)).toHaveLength(1), { timeout: 3000 })

        const sequence = calls.filter(c => isLink(c) || isConfirm(c) || isDismiss(c)).map(c => (
            isConfirm(c) ? 'confirm' : isDismiss(c) ? 'dismiss' : 'link'
        ))
        expect(sequence).toEqual(['link', 'confirm', 'link', 'dismiss'])
        expect(calls.filter(isLink).every(c => c.body?.driverId === 'drv-1' && c.body?.telegramId === '700000001')).toBe(true)
    })

    it.each([
        ['the Driver belongs to another person Contact', { personContactId: 'contact-p' }],
        ['the Fleet cluster carries warnings or merge candidates', { personReviewRequired: true }],
    ])('offers no link or confirmation when %s', async (_label, state) => {
        const calls = stubServer(call => {
            if (call.url === '/api/bot-users') return [200, { linked: [], requests: [request] }]
            if (isSearch(call)) return [200, { drivers: [{ ...driver, ...state }], checkedParks: 6, errors: [] }]
            return [500, {}]
        })
        await openSearch()

        expect(screen.getByText('Нужна сверка контакта')).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Привязать' })).toBeNull()
        expect(calls.filter(c => isLink(c) || isConfirm(c))).toHaveLength(0)
    })

    it('explains that the person must write to the bot first when there is no Chat Contact', async () => {
        const noChat = { ...request, chatId: null, chatContactId: null }
        const calls = stubServer(call => {
            if (call.url === '/api/bot-users') return [200, { linked: [], requests: [noChat] }]
            if (isSearch(call)) return [200, { drivers: [driver], checkedParks: 6, errors: [] }]
            return [500, {}]
        })
        await openSearch(noChat)

        expect(screen.getByText('Пользователь ещё не писал боту. Привязка станет доступна после его первого сообщения.')).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Привязать' })).toBeNull()
        expect(calls.filter(c => isLink(c) || isConfirm(c))).toHaveLength(0)
    })

    it.each([
        [409, { status: 'contradiction' }, 'Этот профиль водителя уже подтверждён для другого контакта. Нужна сверка контактов в CRM.'],
        [409, { error: 'Manual reconciliation required', confirmation: { status: 'needs_reconciliation' }, automaticMerge: { status: 'policy_blocked' } }, 'Этот профиль водителя уже подтверждён для другого контакта. Нужна сверка контактов в CRM.'],
        [503, { error: 'Fresh complete Fleet confirmation evidence is required' }, 'Парки Яндекса сейчас не отвечают. Повторите подтверждение позже.'],
        [403, { error: 'Forbidden' }, 'Нет прав для подтверждения водителя.'],
    ])('fails closed when the Contacts owner refuses (%s)', async (status, payload, message) => {
        const calls = stubServer(call => {
            if (call.url === '/api/bot-users') return [200, { linked: [], requests: [request] }]
            if (isSearch(call)) return [200, { drivers: [driver], checkedParks: 6, errors: [] }]
            if (isLink(call)) return [409, { code: 'PERSON_CONFIRMATION_REQUIRED', error: 'x' }]
            if (isConfirm(call)) return [status, payload]
            return [500, {}]
        })
        await openSearch()
        fireEvent.click(screen.getByRole('button', { name: 'Привязать' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить водителя' }))

        await screen.findByText(message)
        expect(screen.queryByRole('button', { name: 'Привязать Telegram' })).toBeNull()
        expect(calls.filter(isLink)).toHaveLength(1)
        expect(calls.filter(isDismiss)).toHaveLength(0)
    })

    it('keeps the confirmation when the link then fails, and a retried link succeeds once', async () => {
        let confirmed = false
        let linkAttempts = 0
        const calls = stubServer(call => {
            if (call.url === '/api/bot-users' && call.method === 'GET') return [200, { linked: [], requests: [request] }]
            if (isSearch(call)) return [200, { drivers: [{ ...driver, personContactId: confirmed ? 'contact-t' : null }], checkedParks: 6, errors: [] }]
            if (isConfirm(call)) { confirmed = true; return [200, { confirmation: { status: 'confirmed', contactId: 'contact-t' } }] }
            if (isLink(call)) {
                linkAttempts += 1
                if (!confirmed) return [409, { code: 'PERSON_CONFIRMATION_REQUIRED', error: 'x' }]
                return linkAttempts === 2
                    ? [409, { code: 'TELEGRAM_LINK_REJECTED', error: 'Не удалось привязать Telegram: проверка не пройдена.' }]
                    : [200, { success: true }]
            }
            if (isDismiss(call)) return [200, {}]
            return [500, {}]
        })
        await openSearch()
        fireEvent.click(screen.getByRole('button', { name: 'Привязать' }))
        await clickWhenEnabled('Подтвердить водителя')
        await clickWhenEnabled('Привязать Telegram')

        await screen.findByText('Не удалось привязать Telegram: проверка не пройдена.', undefined, { timeout: 3000 })
        // The Contacts confirmation stands on its own; no second confirmation is needed.
        expect(screen.getByText('Водитель подтверждён.')).toBeTruthy()
        expect(calls.filter(isDismiss)).toHaveLength(0)

        await clickWhenEnabled('Привязать Telegram')
        await waitFor(() => expect(calls.filter(isDismiss)).toHaveLength(1), { timeout: 3000 })
        expect(calls.filter(isConfirm)).toHaveLength(1)
    })

    it('offers the link only after the refresh that follows the confirmation has answered', async () => {
        let confirmed = false
        let answerRefresh = () => {}
        const refreshAnswered = new Promise<void>(resolve => { answerRefresh = resolve })
        const calls = stubServer(async call => {
            if (call.url === '/api/bot-users' && call.method === 'GET') return [200, { linked: [], requests: [request] }]
            if (isSearch(call)) {
                if (confirmed) await refreshAnswered
                return [200, { drivers: [{ ...driver, personContactId: confirmed ? 'contact-t' : null }], checkedParks: 6, errors: [] }]
            }
            if (isConfirm(call)) { confirmed = true; return [200, { confirmation: { status: 'confirmed', contactId: 'contact-t' } }] }
            if (isLink(call)) return confirmed ? [200, { success: true }] : [409, { code: 'PERSON_CONFIRMATION_REQUIRED', error: 'x' }]
            if (isDismiss(call)) return [200, {}]
            return [500, {}]
        })
        await openSearch()
        fireEvent.click(screen.getByRole('button', { name: 'Привязать' }))
        await screen.findByRole('button', { name: 'Подтвердить водителя' })

        // Record the button state of the very first render that offers it.
        const firstRender: boolean[] = []
        const observer = new MutationObserver(() => {
            const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Привязать Telegram')
            if (button && firstRender.length === 0) firstRender.push(button.disabled)
        })
        observer.observe(document.body, { childList: true, subtree: true, attributes: true })
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить водителя' }))
        await screen.findByText('Водитель подтверждён.')
        await waitFor(() => expect(calls.filter(isSearch).length).toBeGreaterThanOrEqual(2), { timeout: 3000 })
        observer.disconnect()
        expect(firstRender).toEqual([true])

        const link = screen.getByRole('button', { name: 'Привязать Telegram' }) as HTMLButtonElement
        expect(link.disabled).toBe(true)
        fireEvent.click(link)
        expect(calls.filter(isLink)).toHaveLength(1)

        answerRefresh()
        await clickWhenEnabled('Привязать Telegram')
        await waitFor(() => expect(calls.filter(isDismiss)).toHaveLength(1), { timeout: 3000 })
        expect(calls.filter(isLink)).toHaveLength(2)
    })

    it('does not offer a confirmation the Contacts owner could not evaluate', async () => {
        const crmOnly = { ...driver, id: 'crm-1', source: 'crm', parkId: null, parkName: null, yandexDriverId: null, profileClusterKey: null }
        const calls = stubServer(call => {
            if (call.url === '/api/bot-users') return [200, { linked: [], requests: [request] }]
            if (isSearch(call)) return [200, { drivers: [crmOnly], checkedParks: 6, errors: [] }]
            if (isLink(call)) return [409, { code: 'PERSON_CONFIRMATION_REQUIRED', error: 'x' }]
            return [500, {}]
        })
        await openSearch()
        fireEvent.click(screen.getByRole('button', { name: 'Привязать' }))

        await screen.findByText('Подтвердить водителя здесь нельзя: профиль не найден в парках Яндекса. Найдите водителя по телефону или ВУ.')
        expect(screen.queryByRole('button', { name: 'Подтвердить водителя' })).toBeNull()
        expect(calls.filter(isConfirm)).toHaveLength(0)
    })
})
