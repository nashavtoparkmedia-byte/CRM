/**
 * opsLog — fail-safe structured logging utility.
 *
 * Outputs JSON lines to stdout (info) or stderr (warn/error).
 * Never throws — any serialization or write failure falls back to console.error.
 */

type LogLevel = 'info' | 'warn' | 'error'

interface LogContext {
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

export function opsLog(level: LogLevel, event: string, context?: LogContext): void {
  try {
    const entry = {
      level,
      event,
      ts: new Date().toISOString(),
      ...context,
    }

    const line = JSON.stringify(entry)

    if (level === 'error') {
      process.stderr.write(line + '\n')
    } else {
      process.stdout.write(line + '\n')
    }
  } catch {
    // Fail-safe: never let logging break business flow
    try {
      console.error(`[opsLog-fallback] level=${level} event=${event}`)
    } catch {
      // Absolute last resort — silently swallow
    }
  }
}
