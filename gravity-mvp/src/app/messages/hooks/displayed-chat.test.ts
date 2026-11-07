import { describe, expect, it } from 'vitest'
import { effectiveChatIdV1, personCardLinkChatIdV1, selectDisplayedChatV1 } from './displayed-chat'

const grouped = { id: 'row-1', allChatIds: ['chat-tg', 'chat-wa'], channelMap: { telegram: 'chat-tg', whatsapp: 'chat-wa' } }
const single = { id: 'chat-tg', allChatIds: ['chat-tg'], channelMap: { telegram: 'chat-tg' } }

describe('selectDisplayedChatV1 — the one «shown conversation» rule', () => {
  it('names nothing without a chat or a known row', () => {
    expect(selectDisplayedChatV1({ chatId: null, activeChannelTab: 'all', chat: grouped })).toEqual({ kind: 'none' })
    expect(selectDisplayedChatV1({ chatId: 'row-1', activeChannelTab: 'all', chat: null })).toEqual({ kind: 'none' })
    expect(effectiveChatIdV1({ kind: 'none' }, 'row-1')).toBe('row-1')
    expect(personCardLinkChatIdV1({ kind: 'none' })).toBeNull()
  })

  it('«Все» over several chats is grouped: the workspace keys on the joined ids and no person link exists (1a)', () => {
    const selection = selectDisplayedChatV1({ chatId: 'row-1', activeChannelTab: 'all', chat: grouped })
    expect(selection).toEqual({ kind: 'grouped', chatIds: ['chat-tg', 'chat-wa'] })
    expect(effectiveChatIdV1(selection, 'row-1')).toBe('chat-tg,chat-wa')
    expect(personCardLinkChatIdV1(selection)).toBeNull()
  })

  it('a channel tab shows exactly that channel’s chat, which is the only id a link may follow (2a)', () => {
    for (const [tab, expected] of [['tg', 'chat-tg'], ['wa', 'chat-wa'], ['telegram', 'chat-tg'], ['whatsapp', 'chat-wa']] as const) {
      const selection = selectDisplayedChatV1({ chatId: 'row-1', activeChannelTab: tab, chat: grouped })
      expect(selection).toEqual({ kind: 'single', chatId: expected })
      expect(effectiveChatIdV1(selection, 'row-1')).toBe(expected)
      expect(personCardLinkChatIdV1(selection)).toBe(expected)
    }
  })

  it('a channel tab without a chat on that channel is empty: no workspace chat, no link (2a edge)', () => {
    const selection = selectDisplayedChatV1({ chatId: 'row-1', activeChannelTab: 'max', chat: grouped })
    expect(selection).toEqual({ kind: 'empty', channel: 'max' })
    expect(effectiveChatIdV1(selection, 'row-1')).toBe('empty:max')
    expect(personCardLinkChatIdV1(selection)).toBeNull()
  })

  it('a tab name that is not an own key of the channel map is an empty channel, never a prototype value', () => {
    for (const tab of ['constructor', '__proto__', 'toString']) {
      const selection = selectDisplayedChatV1({ chatId: 'row-1', activeChannelTab: tab, chat: grouped })
      expect(selection).toEqual({ kind: 'empty', channel: tab })
      expect(personCardLinkChatIdV1(selection)).toBeNull()
    }
  })

  it('a single-chat row on «Все» is that chat', () => {
    const selection = selectDisplayedChatV1({ chatId: 'chat-tg', activeChannelTab: 'all', chat: single })
    expect(selection).toEqual({ kind: 'single', chatId: 'chat-tg' })
    expect(effectiveChatIdV1(selection, 'chat-tg')).toBe('chat-tg')
    expect(personCardLinkChatIdV1(selection)).toBe('chat-tg')
  })

  it('a row without a channel map on a channel tab falls back to the row id, as the workspace always did', () => {
    const selection = selectDisplayedChatV1({ chatId: 'chat-x', activeChannelTab: 'tg', chat: { id: 'chat-x' } })
    expect(selection).toEqual({ kind: 'single', chatId: 'chat-x' })
  })
})
