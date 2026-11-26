import { runYandexSync } from '@/lib/yandexSync'

export type ScheduledYandexSyncResultV1 = {
  ok: boolean
  reason?: 'already_running' | 'cooldown' | 'error' | 'lease_lost'
  cooldownRemainingMs?: number
  errorMessage?: string
  driversUpdated?: number
  ordersProcessed?: number
  recalculatedCount?: number
}

/** Fixed scheduled operation: callers cannot alter cooldown or sync scope. */
export async function runScheduledYandexSyncV1(): Promise<ScheduledYandexSyncResultV1> {
  const result = await runYandexSync({ bypassCooldown: true })
  // Scheduled callers never request detached execution. Keep the public
  // scheduled contract narrow even though the shared coordinator also serves
  // the manual background-start path.
  if (result.reason === 'started') return { ...result, reason: 'already_running', ok: false }
  return result
}
