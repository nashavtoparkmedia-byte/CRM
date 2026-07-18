export async function checkReachability(phone: string): Promise<{
  confirmed: boolean
  reachable: boolean | null
  retryable?: boolean
  reason?: string
  error?: string
}> {
  void phone
  throw new Error('typecheck stub')
}
