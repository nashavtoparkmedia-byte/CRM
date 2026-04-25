"use client"

import { useState, useCallback } from "react"
import { seedEmptyChat } from "./useMessages"

interface StartResult {
  chatId: string
  channel: string
  isNew: boolean
}

interface StartConversationState {
  loading: boolean
  error: string | null
}

const URL_CHANNEL_TO_DB: Record<string, string> = {
  wa: 'whatsapp',
  tg: 'telegram',
  max: 'max',
  ypro: 'yandex_pro',
}

/**
 * Hook для создания/открытия чата.
 *
 * Два сценария:
 * 1. contactId + channel → POST /api/contacts/:id/chats
 * 2. phone + channel → POST /api/contacts/start-conversation
 */
export function useStartConversation() {
  const [state, setState] = useState<StartConversationState>({ loading: false, error: null })

  const startByContact = useCallback(async (contactId: string, urlChannel: string): Promise<StartResult | null> => {
    const dbChannel = URL_CHANNEL_TO_DB[urlChannel] || urlChannel
    setState({ loading: true, error: null })

    try {
      const res = await fetch(`/api/contacts/${contactId}/chats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: dbChannel }),
      })

      const data = await res.json()

      if (!res.ok) {
        const msg = data.message || data.error || `HTTP ${res.status}`
        setState({ loading: false, error: msg })
        return null
      }

      setState({ loading: false, error: null })
      // Warm the message cache so opening this chat doesn't flash a spinner.
      // For freshly-created chats we know the message list is empty.
      seedEmptyChat(data.chat.id)
      return {
        chatId: data.chat.id,
        channel: data.chat.channel,
        isNew: data.chat.isNew,
      }
    } catch (err: any) {
      setState({ loading: false, error: err.message || 'Network error' })
      return null
    }
  }, [])

  const startByPhone = useCallback(async (phone: string, urlChannel: string): Promise<StartResult | null> => {
    const dbChannel = URL_CHANNEL_TO_DB[urlChannel] || urlChannel
    setState({ loading: true, error: null })

    try {
      const res = await fetch('/api/contacts/start-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, channel: dbChannel }),
      })

      const data = await res.json()

      if (!res.ok) {
        const msg = data.message || data.error || `HTTP ${res.status}`
        setState({ loading: false, error: msg })
        return null
      }

      setState({ loading: false, error: null })
      seedEmptyChat(data.chat.id)
      return {
        chatId: data.chat.id,
        channel: data.chat.channel,
        isNew: data.chat.isNew,
      }
    } catch (err: any) {
      setState({ loading: false, error: err.message || 'Network error' })
      return null
    }
  }, [])

  const clearError = useCallback(() => setState(s => ({ ...s, error: null })), [])

  return { ...state, startByContact, startByPhone, clearError }
}
