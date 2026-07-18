type StartResult = {
  chatId: string
  channel: string
  isNew: boolean
}

export function useStartConversation(): {
  loading: boolean
  error: string | null
  startByContact: (contactId: string, channel: string) => Promise<StartResult | null>
  startByPhone: (phone: string, channel: string) => Promise<StartResult | null>
  clearError: () => void
} {
  throw new Error('typecheck stub')
}
