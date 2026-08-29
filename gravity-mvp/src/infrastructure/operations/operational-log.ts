/**
 * Fail-safe structured operational logging infrastructure capability.
 *
 * Domain consumers supply only a level, stable event name and bounded context;
 * no configurable transport, sink or formatter is exposed.
 */
export type OperationalLogLevelV1 = 'info' | 'warn' | 'error'

export interface OperationalLogContextV1 {
  channel?: string
  operation?: string
  chatId?: string
  contactId?: string
  messageId?: string
  clientMessageId?: string
  connectionId?: string
  error?: string
  errorCode?: string
  count?: number
  durationMs?: number
  [key: string]: unknown
}
export function operationalLogV1(
  level: OperationalLogLevelV1,
  event: string,
  context?: OperationalLogContextV1,
): void {
  try {
    const line = JSON.stringify({
      level,
      event,
      ts: new Date().toISOString(),
      ...context,
    })

    if (level === 'error') {
      process.stderr.write(`${line}\n`)
    } else {
      process.stdout.write(`${line}\n`)
    }
  } catch {
    try {
      console.error(`[opsLog-fallback] level=${level} event=${event}`)
    } catch {
      // Logging remains best-effort even when the process console is unavailable.
    }
  }
}
