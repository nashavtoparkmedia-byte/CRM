// TEMPORARY — in-memory log buffer for telephony debugging
// Remove after collecting heartbeat logs

const MAX_ENTRIES = 500

// Use globalThis to persist across hot reloads
const g = globalThis as unknown as { __telephonyLog?: string[] }
if (!g.__telephonyLog) g.__telephonyLog = []

export function memLog(line: string) {
  const ts = new Date().toISOString()
  g.__telephonyLog!.push(`${ts} ${line}`)
  if (g.__telephonyLog!.length > MAX_ENTRIES) {
    g.__telephonyLog!.splice(0, g.__telephonyLog!.length - MAX_ENTRIES)
  }
}

export function getMemLog(): string[] {
  return g.__telephonyLog || []
}

export function clearMemLog(): void {
  g.__telephonyLog = []
}
