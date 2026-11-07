// The one rule for «which conversation is actually shown» in the Messenger.
//
// ChatWorkspace keys its whole state on this answer, and the conversation
// drawer may lead to a person page only from the same answer (BD-F2 1a/2a): a
// grouped row shown on the «Все» tab over several chats names no single person,
// a channel tab without a chat on that channel shows nothing, and only a tab
// that shows exactly one persisted Chat.id may be followed. Both consumers call
// this pure function with the same inputs; there is no second computation.
export type DisplayedChatConversationV1 = {
  id: string
  allChatIds?: string[] | null
  channelMap?: Record<string, string | null | undefined> | null
}

export type DisplayedChatSelectionV1 =
  | { kind: 'none' }
  | { kind: 'single'; chatId: string }
  | { kind: 'grouped'; chatIds: string[] }
  | { kind: 'empty'; channel: string }

export function normalizeChannelTabV1(activeChannelTab: string): string {
  return activeChannelTab === 'wa' ? 'whatsapp' : activeChannelTab === 'tg' ? 'telegram' : activeChannelTab
}

export function selectDisplayedChatV1(input: {
  chatId: string | null | undefined
  activeChannelTab: string
  chat: DisplayedChatConversationV1 | null | undefined
}): DisplayedChatSelectionV1 {
  const { chatId, activeChannelTab, chat } = input
  if (!chatId || !chat) return { kind: 'none' }
  if (activeChannelTab === 'all' && chat.allChatIds && chat.allChatIds.length > 1) {
    return { kind: 'grouped', chatIds: [...chat.allChatIds] }
  }
  if (activeChannelTab !== 'all' && chat.channelMap) {
    const channel = normalizeChannelTabV1(activeChannelTab)
    // Own keys only: a URL tab such as `constructor` must read as an empty channel, never a prototype value.
    const channelChatId = Object.hasOwn(chat.channelMap, channel) ? chat.channelMap[channel] : undefined
    return typeof channelChatId === 'string' && channelChatId !== ''
      ? { kind: 'single', chatId: channelChatId }
      : { kind: 'empty', channel }
  }
  return { kind: 'single', chatId }
}

/** The legacy remount key ChatWorkspace has always used, derived from the selection and nothing else. */
export function effectiveChatIdV1(selection: DisplayedChatSelectionV1, chatId: string | null | undefined): string | null {
  switch (selection.kind) {
    case 'none': return chatId ?? null
    case 'single': return selection.chatId
    case 'grouped': return selection.chatIds.join(',')
    case 'empty': return `empty:${selection.channel}`
  }
}

/** The exact persisted Chat.id a person-page link may be resolved from, or null when none is shown. */
export function personCardLinkChatIdV1(selection: DisplayedChatSelectionV1): string | null {
  return selection.kind === 'single' ? selection.chatId : null
}
