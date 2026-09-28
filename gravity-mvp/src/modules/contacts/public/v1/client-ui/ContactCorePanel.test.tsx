/**
 * The Contact core panel proven against a summary alone.
 *
 * These tests also pin what the panel must NOT do: it renders from its prop, so
 * it performs no fetch of any kind, and a channel row states that an identity
 * exists rather than that a message can be delivered.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ContactCorePanel from './ContactCorePanel'
import type { ContactCardSummaryV1 } from '../contact-card-summary'

function summary(overrides: Partial<ContactCardSummaryV1> = {}): ContactCardSummaryV1 {
  return {
    contactId: 'contact-1',
    displayName: 'Иван Петров',
    displayTitle: 'Иван Петров · +7 900 123-45-67',
    primaryPhone: '+7 900 123-45-67',
    phoneCount: 1,
    channels: [{ channel: 'telegram', identityCount: 1, hasActiveIdentity: true, conflictState: 'clear' }],
    hasIdentityConflict: false,
    source: 'chat',
    lineage: { mergedFromCount: 0 },
    ...overrides,
  }
}

afterEach(() => cleanup())

describe('ContactCorePanel', () => {
  it('renders the canonical title, the primary phone and the channel presence', () => {
    render(<ContactCorePanel summary={summary()} />)
    expect(screen.getByTestId('contact-core-title').textContent).toBe('Иван Петров · +7 900 123-45-67')
    expect(screen.getByTestId('contact-core-primary-phone').textContent).toBe('+7 900 123-45-67')
    expect(screen.getByTestId('contact-core-channel-telegram').textContent).toContain('Идентичность есть')
    expect(screen.getByTestId('contact-core-phone-count').textContent).toBe('1')
    expect(screen.getByTestId('contact-core-source').textContent).toBe('Из переписки')
  })

  it('renders a minimal contact without inventing facts', () => {
    render(<ContactCorePanel summary={summary({
      displayTitle: 'Контакт',
      displayName: 'Контакт',
      primaryPhone: null,
      phoneCount: 0,
      channels: [],
    })} />)
    expect(screen.getByTestId('contact-core-primary-phone').textContent).toBe('Телефон не указан')
    expect(screen.getByTestId('contact-core-channels-empty')).toBeTruthy()
    expect(screen.queryByTestId('contact-core-channels')).toBeNull()
    expect(screen.queryByTestId('contact-core-identity-conflict')).toBeNull()
    expect(screen.queryByTestId('contact-core-merged-from')).toBeNull()
  })

  it('renders several channels and their identity counts', () => {
    render(<ContactCorePanel summary={summary({
      channels: [
        { channel: 'max', identityCount: 1, hasActiveIdentity: false, conflictState: 'clear' },
        { channel: 'telegram', identityCount: 2, hasActiveIdentity: true, conflictState: 'clear' },
        { channel: 'whatsapp', identityCount: 1, hasActiveIdentity: true, conflictState: 'clear' },
      ],
    })} />)
    expect(screen.getByTestId('contact-core-channel-max').textContent).toContain('Неактивна')
    expect(screen.getByTestId('contact-core-channel-telegram').textContent).toContain('2')
    expect(screen.getByTestId('contact-core-channel-whatsapp')).toBeTruthy()
  })

  it('shows a conflicted identity at channel and contact level', () => {
    render(<ContactCorePanel summary={summary({
      channels: [{ channel: 'telegram', identityCount: 2, hasActiveIdentity: true, conflictState: 'conflicted' }],
      hasIdentityConflict: true,
    })} />)
    expect(screen.getByTestId('contact-core-channel-telegram').textContent).toContain('Конфликт')
    expect(screen.getByTestId('contact-core-identity-conflict').textContent).toContain('конфликт идентичности')
  })

  it('shows the lineage count only when there is one', () => {
    render(<ContactCorePanel summary={summary({ lineage: { mergedFromCount: 3 } })} />)
    expect(screen.getByTestId('contact-core-merged-from').textContent).toBe('3')
  })

  it('performs no network call of any kind', () => {
    const fetchSpy = vi.fn()
    const original = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      render(<ContactCorePanel summary={summary({ hasIdentityConflict: true, lineage: { mergedFromCount: 2 } })} />)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = original
    }
  })

  it('never renders a provider id or a delivery claim', () => {
    const { container } = render(<ContactCorePanel summary={summary({
      channels: [{ channel: 'telegram', identityCount: 1, hasActiveIdentity: true, conflictState: 'clear' }],
    })} />)
    const text = container.textContent ?? ''
    for (const forbidden of ['902100000001', 'Доставлено', 'Доступен', 'Онлайн', 'Написать']) {
      expect(text).not.toContain(forbidden)
    }
  })
})
