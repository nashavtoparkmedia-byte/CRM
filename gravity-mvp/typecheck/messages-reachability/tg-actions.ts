export async function checkTelegramReachability(phone: string): Promise<{
  telegramId?: string
  reachable?: boolean | null
  error?: string
}> {
  void phone
  throw new Error('typecheck stub')
}
