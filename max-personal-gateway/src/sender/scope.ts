export function canaryConversationScope(accountId: string, conversationKey: string): string {
  return `${accountId.length}:${accountId}${conversationKey.length}:${conversationKey}`
}
