/**
 * TransportRegistry — unified lifecycle management for WA and TG transport connections.
 *
 * Provides:
 * - Instance identity (instanceId) to guard against stale callbacks
 * - Explicit lifecycle state model
 * - Reconnect policy with exponential backoff, jitter, and duplicate protection
 * - Centralized health/status reporting
 */

import crypto from 'crypto'

// ── State Model ──────────────────────────────────────────────
// degraded intentionally omitted — not used in this iteration.
// Add when runtime health anomalies (e.g. high latency) need a pre-reconnect state.
export type TransportState = 'initializing' | 'ready' | 'reconnecting' | 'failed' | 'stopped'

export interface ConnectionEntry {
  connectionId: string
  channel: 'whatsapp' | 'telegram'
  instanceId: string | null     // null until beginNewInstance()
  state: TransportState
  lastSeen: Date | null
  lastError: string | null
  retryAttempt: number
  startedAt: Date
  readyAt: Date | null
  reconnectInFlight: boolean    // duplicate reconnect guard
}

// ── Registry (module-level singleton, survives hot reload) ───
const globalForRegistry = global as unknown as { _transportRegistry?: Map<string, ConnectionEntry> }
const entries = globalForRegistry._transportRegistry || new Map<string, ConnectionEntry>()
globalForRegistry._transportRegistry = entries
globalForRegistry._transportRegistry = entries

// Active reconnect timers — keyed by connectionId. Cleared on new instance or stop.
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()

// ── Entry Lifecycle ──────────────────────────────────────────

/** Create entry if not exists. Idempotent. Does NOT generate instanceId. */
export function ensureEntry(connectionId: string, channel: 'whatsapp' | 'telegram'): ConnectionEntry {
  let entry = entries.get(connectionId)
  if (!entry) {
    entry = {
      connectionId,
      channel,
      instanceId: null,
      state: 'stopped',
      lastSeen: null,
      lastError: null,
      retryAttempt: 0,
      startedAt: new Date(),
      readyAt: null,
      reconnectInFlight: false,
    }
    entries.set(connectionId, entry)
  }
  return entry
}

/** Start a new lifecycle instance. Invalidates previous instanceId. Returns new instanceId. */
export function beginNewInstance(connectionId: string): string {
  const entry = entries.get(connectionId)
  if (!entry) throw new Error(`[TransportRegistry] No entry for ${connectionId}. Call ensureEntry first.`)

  // Cancel any pending reconnect from previous instance
  cancelReconnect(connectionId)

  const instanceId = crypto.randomUUID()
  entry.instanceId = instanceId
  entry.state = 'initializing'
  entry.startedAt = new Date()
  entry.readyAt = null
  entry.lastError = null
  entry.retryAttempt = 0
  entry.reconnectInFlight = false

  log('instance_begin', connectionId, entry.channel, { instanceId: short(instanceId) })
  return instanceId
}

// ── State Transitions (all require instanceId match) ─────────

export function setReady(connectionId: string, instanceId: string): void {
  if (!guardInstance(connectionId, instanceId, 'setReady')) return
  const entry = entries.get(connectionId)!
  entry.state = 'ready'
  entry.readyAt = new Date()
  entry.lastSeen = new Date()
  entry.retryAttempt = 0
  entry.reconnectInFlight = false
  entry.lastError = null
  log('state_ready', connectionId, entry.channel, { instanceId: short(instanceId) })
}

export function setReconnecting(connectionId: string, instanceId: string): void {
  if (!guardInstance(connectionId, instanceId, 'setReconnecting')) return
  const entry = entries.get(connectionId)!
  entry.state = 'reconnecting'
  log('state_reconnecting', connectionId, entry.channel, { instanceId: short(instanceId), attempt: entry.retryAttempt })
}

export function setFailed(connectionId: string, instanceId: string, error: string): void {
  if (!guardInstance(connectionId, instanceId, 'setFailed')) return
  const entry = entries.get(connectionId)!
  entry.state = 'failed'
  entry.lastError = error
  entry.reconnectInFlight = false
  cancelReconnect(connectionId)
  log('state_failed', connectionId, entry.channel, { instanceId: short(instanceId), error })
}

/** Admin/system shutdown only. No instanceId guard — intentional override. */
export function setStopped(connectionId: string): void {
  const entry = entries.get(connectionId)
  if (!entry) return
  entry.state = 'stopped'
  entry.reconnectInFlight = false
  cancelReconnect(connectionId)
  log('state_stopped', connectionId, entry.channel)
}

// ── Guards ────────────────────────────────────────────────────

export function isCurrentInstance(connectionId: string, instanceId: string): boolean {
  const entry = entries.get(connectionId)
  return !!entry && entry.instanceId === instanceId
}

/** Update lastSeen only if instanceId matches current. */
export function touch(connectionId: string, instanceId: string): void {
  if (!isCurrentInstance(connectionId, instanceId)) return
  const entry = entries.get(connectionId)!
  entry.lastSeen = new Date()
}

// ── Reconnect Policy ─────────────────────────────────────────

const MAX_RETRY_ATTEMPTS = 10
const BASE_DELAY_MS = 2000
const MAX_DELAY_MS = 60_000
const JITTER_FACTOR = 0.2

/**
 * Schedule reconnect with exponential backoff + jitter.
 * Duplicate protection: if reconnect already in-flight for this entry, no-op.
 * Stale guard: checks instanceId before each retry.
 */
export function scheduleReconnect(
  connectionId: string,
  instanceId: string,
  reconnectFn: () => Promise<void>
): void {
  const entry = entries.get(connectionId)
  if (!entry) return

  // Duplicate protection
  if (entry.reconnectInFlight) {
    log('reconnect_already_scheduled', connectionId, entry.channel, { instanceId: short(instanceId) })
    return
  }

  // Check retry limit
  if (entry.retryAttempt >= MAX_RETRY_ATTEMPTS) {
    // Final instanceId check before marking failed
    if (isCurrentInstance(connectionId, instanceId)) {
      setFailed(connectionId, instanceId, `Max retry attempts (${MAX_RETRY_ATTEMPTS}) exhausted`)
    }
    return
  }

  entry.reconnectInFlight = true
  entry.retryAttempt++

  // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 60s cap
  const rawDelay = Math.min(BASE_DELAY_MS * Math.pow(2, entry.retryAttempt - 1), MAX_DELAY_MS)
  // Jitter: ±20%
  const jitter = rawDelay * JITTER_FACTOR * (Math.random() * 2 - 1)
  const delay = Math.round(rawDelay + jitter)

  log('reconnect_scheduled', connectionId, entry.channel, {
    instanceId: short(instanceId),
    attempt: entry.retryAttempt,
    delayMs: delay,
  })

  const timer = setTimeout(async () => {
    reconnectTimers.delete(connectionId)

    // Stale guard: abort if instance changed since scheduling
    if (!isCurrentInstance(connectionId, instanceId)) {
      log('stale_reconnect_aborted', connectionId, entry.channel, { scheduledFor: short(instanceId) })
      entry.reconnectInFlight = false
      return
    }

    log('reconnect_attempt', connectionId, entry.channel, { attempt: entry.retryAttempt })

    try {
      await reconnectFn()
      // reconnectFn is expected to call setReady() on success,
      // which resets reconnectInFlight and retryAttempt.
    } catch (err: any) {
      log('reconnect_attempt_failed', connectionId, entry.channel, { attempt: entry.retryAttempt, error: err.message })
      entry.reconnectInFlight = false

      // Schedule next attempt if still current instance
      if (isCurrentInstance(connectionId, instanceId)) {
        scheduleReconnect(connectionId, instanceId, reconnectFn)
      }
    }
  }, delay)

  reconnectTimers.set(connectionId, timer)
}

// ── Query ─────────────────────────────────────────────────────

export function getEntry(connectionId: string): ConnectionEntry | null {
  return entries.get(connectionId) || null
}

export function getAllEntries(): ConnectionEntry[] {
  return Array.from(entries.values())
}

// ── Internal Helpers ──────────────────────────────────────────

function cancelReconnect(connectionId: string): void {
  const timer = reconnectTimers.get(connectionId)
  if (timer) {
    clearTimeout(timer)
    reconnectTimers.delete(connectionId)
  }
}

function guardInstance(connectionId: string, instanceId: string, action: string): boolean {
  if (!isCurrentInstance(connectionId, instanceId)) {
    const entry = entries.get(connectionId)
    log('stale_client_ignored', connectionId, entry?.channel || '?', {
      action,
      staleInstanceId: short(instanceId),
      currentInstanceId: short(entry?.instanceId || 'none'),
    })
    return false
  }
  return true
}

function short(id: string): string {
  return id.substring(0, 8)
}

function log(event: string, connectionId: string, channel: string, extra?: Record<string, any>): void {
  const prefix = channel === 'whatsapp' ? 'WA' : 'TG'
  const extraStr = extra ? ' ' + Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ') : ''
  console.log(`[${prefix}-TRANSPORT] ${event} connId=${connectionId}${extraStr}`)
}
