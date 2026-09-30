/**
 * The Contact channel-state panel proven against one view alone.
 *
 * These tests pin what the panel must NOT do as much as what it shows: it renders
 * from its prop with no fetch, it never claims a channel is unavailable, it offers
 * no resolution action, and it distinguishes a blocking conflict from one that
 * only failed a transport.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import ContactChannelStatePanel from './ContactChannelStatePanel'
import type { ContactIdentityConflictViewV1 } from '../contact-identity-conflict-view'

function view(overrides: Partial<ContactIdentityConflictViewV1> = {}): ContactIdentityConflictViewV1 {
  return {
    contactId: 'contact-1',
    hasOpenConflict: false,
    hasPersonBlockingConflict: false,
    closedConflictCount: 0,
    channels: [],
    conflicts: [],
    ...overrides,
  }
}

const PERSON_CONFLICT = {
  identityId: 'identity-max',
  channel: 'max',
  conflictClass: 'channel_identity_collision' as const,
  scope: 'person' as const,
  blocksPersonOperations: true,
  identityState: 'active' as const,
  detectedAt: '2026-09-22T11:44:50.459Z',
}

const TRANSPORT_CONFLICT = {
  identityId: 'identity-wa',
  channel: 'whatsapp',
  conflictClass: 'channel_identity_collision' as const,
  scope: 'transport_only' as const,
  blocksPersonOperations: false,
  identityState: 'active' as const,
  detectedAt: '2026-09-20T10:00:00.000Z',
}

afterEach(() => cleanup())

describe('ContactChannelStatePanel', () => {
  it('states plainly that there are no conflicts', () => {
    render(<ContactChannelStatePanel view={view()} />)
    expect(screen.getByTestId('contact-conflicts-empty').textContent ?? '').toContain('Конфликтов идентичности нет')
    expect(screen.queryByTestId('contact-conflict-headline')).toBeNull()
  })

  it('asks for a check only when something actually blocks', () => {
    render(<ContactChannelStatePanel view={view({
      hasOpenConflict: true, hasPersonBlockingConflict: true,
      channels: [{ channel: 'max', openConflictCount: 1, personBlockingCount: 1 }],
      conflicts: [PERSON_CONFLICT],
    })} />)
    expect(screen.getByTestId('contact-conflict-headline').textContent ?? '').toContain('требуется проверка')
    expect(screen.getByTestId('contact-conflict-max-channel_identity_collision').textContent ?? '')
      .toContain('Конфликт идентичности канала')
  })

  it('says a transport conflict does not block, and never that the channel is unavailable', () => {
    render(<ContactChannelStatePanel view={view({
      hasOpenConflict: true, hasPersonBlockingConflict: false,
      channels: [{ channel: 'whatsapp', openConflictCount: 1, personBlockingCount: 0 }],
      conflicts: [TRANSPORT_CONFLICT],
    })} />)
    const headline = screen.getByTestId('contact-conflict-headline')
    expect(headline.textContent ?? '').toContain('операции не заблокированы')
    expect(headline.textContent ?? '').not.toContain('требуется проверка')
    const panel = screen.getByTestId('contact-channel-state-panel')
    for (const forbidden of ['недоступ', 'не доставл', 'не отправл', 'офлайн', 'отключ']) {
      expect(panel.textContent ?? '', `claims ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('renders both a blocking and a non-blocking conflict distinctly', () => {
    render(<ContactChannelStatePanel view={view({
      hasOpenConflict: true, hasPersonBlockingConflict: true,
      channels: [
        { channel: 'max', openConflictCount: 1, personBlockingCount: 1 },
        { channel: 'whatsapp', openConflictCount: 1, personBlockingCount: 0 },
      ],
      conflicts: [PERSON_CONFLICT, TRANSPORT_CONFLICT],
    })} />)
    expect(screen.getByTestId('contact-conflict-max-channel_identity_collision').textContent ?? '').toContain('Требуется проверка')
    expect(screen.getByTestId('contact-conflict-whatsapp-channel_identity_collision').textContent ?? '').toContain('Не блокирует')
  })

  it('labels a latch-only conflict and a contact-scoped one', () => {
    render(<ContactChannelStatePanel view={view({
      hasOpenConflict: true, hasPersonBlockingConflict: true,
      channels: [{ channel: 'max', openConflictCount: 1, personBlockingCount: 1 }],
      conflicts: [
        { ...PERSON_CONFLICT, conflictClass: 'identity_conflict_flag', detectedAt: null },
        {
          identityId: null, channel: null, conflictClass: 'confirmed_driver_cluster_contradiction',
          scope: 'person', blocksPersonOperations: true, identityState: 'contact', detectedAt: null,
        },
      ],
    })} />)
    expect(screen.getByTestId('contact-conflict-max-identity_conflict_flag').textContent ?? '')
      .toContain('Идентичность отмечена как конфликтная')
    const contactScoped = screen.getByTestId('contact-conflict-none-confirmed_driver_cluster_contradiction')
    expect(contactScoped.textContent ?? '').toContain('Противоречие подтверждения водителя')
    expect(contactScoped.textContent ?? '').toContain('относится к карточке целиком')
  })

  it('explains an identity that merge removed', () => {
    render(<ContactChannelStatePanel view={view({
      hasOpenConflict: true,
      conflicts: [{ ...PERSON_CONFLICT, identityState: 'missing', blocksPersonOperations: false }],
    })} />)
    expect(screen.getByTestId('contact-conflict-max-channel_identity_collision').textContent ?? '')
      .toContain('идентичность удалена')
  })

  it('names an unknown class without inventing detail', () => {
    render(<ContactChannelStatePanel view={view({
      hasOpenConflict: true,
      conflicts: [{ ...PERSON_CONFLICT, conflictClass: 'unknown' }],
    })} />)
    expect(screen.getByTestId('contact-conflict-max-unknown').textContent ?? '').toContain('Неизвестный конфликт')
  })

  it('shows the closed count without any closed detail', () => {
    render(<ContactChannelStatePanel view={view({ closedConflictCount: 3 })} />)
    expect(screen.getByTestId('contact-conflicts-closed').textContent ?? '').toContain('Ранее устранённых: 3')
  })

  it('hides the closed line when there is nothing closed', () => {
    render(<ContactChannelStatePanel view={view()} />)
    expect(screen.queryByTestId('contact-conflicts-closed')).toBeNull()
  })

  it('offers no action of any kind', () => {
    render(<ContactChannelStatePanel view={view({
      hasOpenConflict: true, hasPersonBlockingConflict: true, conflicts: [PERSON_CONFLICT],
    })} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
  })
})
