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
export function runScheduledYandexSyncV1(): Promise<ScheduledYandexSyncResultV1> {
  return runYandexSync({ bypassCooldown: true })
}
