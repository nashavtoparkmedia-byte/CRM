import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ContactChannelRow from './ContactChannelRow'

describe('ContactChannelRow', () => {
    it.each([
        ['max', 'MAX', '💬'],
        ['telegram', 'Telegram', '✈️'],
        ['whatsapp', 'WhatsApp', '📱'],
    ])('keeps the %s write action inside the canonical row', (provider, providerLabel, icon) => {
        const { container } = render(
            <ContactChannelRow
                provider={provider}
                providerLabel={providerLabel}
                icon={icon}
                dotClassName="bg-emerald-500"
                dotTitle="Аккаунт найден"
                badges={[
                    { label: 'Связан', className: 'bg-emerald-50 text-emerald-700', title: 'Identity связана' },
                    { label: 'Автоматически', className: 'bg-gray-50 text-gray-500', title: 'Связан по номеру' },
                ]}
                isWriting={false}
                onWrite={vi.fn()}
            />,
        )

        const row = container.querySelector(`[data-channel-row="${provider}"]`)
        const action = screen.getByRole('button', { name: 'Написать' })

        expect(row).not.toBeNull()
        expect(row?.contains(action)).toBe(true)
        expect(row?.querySelectorAll('[data-channel-action]')).toHaveLength(1)
        expect(row?.textContent).toContain(providerLabel)
        expect(row?.textContent).toContain('Связан')
        expect(row?.textContent).toContain('Автоматически')
    })

    it('keeps the action in the same row for an orphan linked identity', () => {
        const { container } = render(
            <ContactChannelRow
                provider="max"
                providerLabel="MAX"
                icon="💬"
                dotClassName="bg-gray-300"
                dotTitle="Проверяется"
                badges={[
                    { label: 'Связан', className: 'bg-emerald-50 text-emerald-700', title: 'Identity связана' },
                ]}
                isWriting={false}
                onWrite={vi.fn()}
            />,
        )

        const row = container.querySelector('[data-channel-row="max"]')
        const action = screen.getByRole('button', { name: 'Написать' })

        expect(row?.querySelector('[data-channel-badges]')?.textContent).toBe('Связан')
        expect(row?.contains(action)).toBe(true)
        expect(action.closest('[data-channel-row]')).toBe(row)
    })
})
