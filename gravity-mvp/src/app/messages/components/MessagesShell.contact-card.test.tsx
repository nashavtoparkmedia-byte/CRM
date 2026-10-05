/**
 * The M3A2 opt-in mount in the Messaging host.
 *
 * Only `profile=1` with the exact `card=1` mounts the platform-shell Contact
 * Card; `profile=1` with anything else keeps the legacy drawer; no profile mounts
 * neither. The two surfaces are recorders, so the persisted Chat.id each one
 * receives is asserted, and the real navigation hook runs against a mocked
 * router so closing the card is proven to use the drawer's own semantics.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  search: '',
  push: vi.fn(),
  replace: vi.fn(),
  shellProps: [] as Array<{ chatId: string; onClose: () => void }>,
  drawerProps: [] as Array<{ chatId: string }>,
  useConversations: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  usePathname: () => '/messages',
  useSearchParams: () => new URLSearchParams(mocks.search),
}))
vi.mock('./ChatList', () => ({ default: () => <div data-testid="chat-list" /> }))
vi.mock('./ChatWorkspace', () => ({ default: () => <div data-testid="chat-workspace" /> }))
vi.mock('./ContactProfileDrawer', () => ({
  default: (props: { chatId: string }) => {
    mocks.drawerProps.push(props)
    return <div data-testid="legacy-drawer">{props.chatId}</div>
  },
}))
vi.mock('@/infrastructure/ui/contact-card/ContactCardShell', () => ({
  default: (props: { chatId: string; onClose: () => void }) => {
    mocks.shellProps.push(props)
    return <div data-testid="contact-card-shell">{props.chatId}</div>
  },
}))
vi.mock('../hooks/useConversations', () => ({ useConversations: mocks.useConversations }))

import MessagesShell from './MessagesShell'

function mount({ search, isProfileOpen, chatId = 'chat-1' }: { search: string; isProfileOpen: boolean; chatId?: string | null }) {
  mocks.search = search
  return render(
    <MessagesShell
      initialChatId={chatId}
      activeListTab="all"
      activeChannelTab="all"
      isProfileOpen={isProfileOpen}
      initialMessageId={null}
    />,
  )
}

beforeEach(() => {
  mocks.push.mockReset()
  mocks.replace.mockReset()
  mocks.shellProps.length = 0
  mocks.drawerProps.length = 0
  mocks.useConversations.mockReset()
})

afterEach(() => cleanup())

describe('MessagesShell Contact Card opt-in', () => {
  it('mounts only the Contact Card for profile=1&card=1, with the persisted Chat.id', () => {
    mount({ search: 'id=chat-1&profile=1&card=1', isProfileOpen: true })

    expect(screen.getByTestId('contact-card-shell').textContent).toBe('chat-1')
    expect(screen.queryByTestId('legacy-drawer')).toBeNull()
    expect(mocks.shellProps.at(-1)?.chatId).toBe('chat-1')
    expect(mocks.drawerProps).toEqual([])
  })

  it('keeps the legacy drawer for profile=1 without a card flag', () => {
    mount({ search: 'id=chat-1&profile=1', isProfileOpen: true })

    expect(screen.getByTestId('legacy-drawer').textContent).toBe('chat-1')
    expect(screen.queryByTestId('contact-card-shell')).toBeNull()
    expect(mocks.shellProps).toEqual([])
  })

  it.each(['card=2', 'card=true', 'card=', 'card=1x', 'card= 1', 'Card=1'])('keeps the legacy drawer for %s', (flag) => {
    mount({ search: `id=chat-1&profile=1&${flag}`, isProfileOpen: true })

    expect(screen.getByTestId('legacy-drawer')).toBeTruthy()
    expect(screen.queryByTestId('contact-card-shell')).toBeNull()
  })

  it('mounts nothing for card=1 without profile=1', () => {
    mount({ search: 'id=chat-1&card=1', isProfileOpen: false })

    expect(screen.queryByTestId('contact-card-shell')).toBeNull()
    expect(screen.queryByTestId('legacy-drawer')).toBeNull()
  })

  it('mounts nothing without a selected chat, in either mode', () => {
    mount({ search: 'profile=1&card=1', isProfileOpen: true, chatId: null })
    expect(screen.queryByTestId('contact-card-shell')).toBeNull()
    expect(screen.queryByTestId('legacy-drawer')).toBeNull()
    cleanup()

    mount({ search: 'profile=1', isProfileOpen: true, chatId: null })
    expect(screen.queryByTestId('contact-card-shell')).toBeNull()
    expect(screen.queryByTestId('legacy-drawer')).toBeNull()
  })

  it('closes the card exactly as the drawer closes: profile is removed, everything else kept', () => {
    mount({ search: 'id=chat-1&channel=tg&profile=1&card=1', isProfileOpen: true })

    mocks.shellProps.at(-1)?.onClose()

    expect(mocks.push).toHaveBeenCalledTimes(1)
    expect(mocks.push).toHaveBeenCalledWith('/messages?id=chat-1&channel=tg&card=1', { scroll: false })
  })

  it('derives no Contact identity from the conversation list in card mode', () => {
    mount({ search: 'id=chat-1&profile=1&card=1', isProfileOpen: true })

    expect(mocks.useConversations).not.toHaveBeenCalled()
    expect(Object.keys(mocks.shellProps.at(-1) ?? {}).sort()).toEqual(['chatId', 'onClose'])
  })
})
