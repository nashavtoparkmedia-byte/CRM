'use strict'

// ─── MAX live-acceptance guard ───────────────────────────────────────────────
// A recipient allowlist and send cap that exist only for the live provider
// acceptance on Yoko_PC (Owner mandate 2026-11-11, Security rulings D1/D2).
//
// Part 1 is the shared reader of yoko.live-acceptance.recipient-allowlist.v1,
// a port of gravity-mvp messaging/public/v1/live-acceptance-recipient-guard.ts
// (the scraper is a separate package and cannot import it). It answers the
// same shared conformance vectors (test/fixtures/...vectors.json):
// - YOKO_LIVE_ACCEPTANCE unset or empty: OFF. Every call returns at once and
//   nothing is read, written or logged. Production never sets it.
// - YOKO_LIVE_ACCEPTANCE=1: ENFORCE, fail-closed. The allowlist file
//   (YOKO_LIVE_RECIPIENT_ALLOWLIST_FILE) must be present, valid and unexpired,
//   the lane must list a recipient, and the state directory
//   (YOKO_LIVE_STATE_DIR, absolute, writable) must be usable; otherwise every
//   send and every inbound peer of the lane is refused.
// - Any other value: refuse everything (a typo never turns the guard off).
// Matching is exact on the id. The cap is one exclusively created slot file
// per send, re-read on every send, so it survives restarts.
//
// Part 2 is the MAX scraper's use of it, the last outbound choke point:
// - L1: every outbound provider action (text, media, reaction, delete) takes
//   one permit right before it runs (`beginSend`: allowlist, cap, spacing,
//   claimed slot) and each sender checks that the chat it actually resolved
//   is that permitted chat (`checkTarget`);
// - L2: a send-class frame the scraper builds itself passes only for the
//   permitted chat, within the permit, at most three times;
// - L3: in the page, the socket drops a send-class frame nobody armed;
// - a send-class frame on the wire for a chat that is not listed trips the
//   guard: every later send of the run is refused;
// - inbound from a chat that is not listed is not forwarded to the CRM, and
//   history catch-up skips such chats; history import stays off;
// - the M-05 burst exception (Security D2) is an operator file next to the
//   allowlist (YOKO_LIVE_BURST_OVERRIDE_FILE).
//
// The MAX recipient id in the file is the protocol chat id string the CRM
// stores and sends. Inside the page the same chat also appears as its MAX
// "real" id (the web route, the BigInt in frames); the scraper maps such a
// value to a listed id only when it decodes to the same chat, then checks the
// listed id exactly.

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')

const { OP, maxRealIdFromProtocolId } = require('../transport/TransportInterceptor')

// ═══ Part 1: the shared reader ═══════════════════════════════════════════════

const LIVE_ACCEPTANCE_ALLOWLIST_SCHEMA_V1 = 'yoko.live-acceptance.recipient-allowlist.v1'
const LIVE_ACCEPTANCE_LANES_V1 = Object.freeze(['whatsapp', 'max', 'telegram_mtproto', 'telegram_bot'])
const LIVE_GUARD_CODES = Object.freeze([
  'LIVE_GUARD_CONFIG_INVALID', 'LIVE_GUARD_CONFIG_CHANGED', 'LIVE_GUARD_EXPIRED', 'LIVE_GUARD_LANE_EMPTY', 'LIVE_GUARD_NOT_LISTED',
  'LIVE_GUARD_CAP_REACHED', 'LIVE_GUARD_INTERVAL', 'LIVE_GUARD_COUNTER_UNAVAILABLE',
])

const MAX_SENDS_LIMIT = 1000
const CLAIM_ATTEMPTS  = 8
const RUN_ID          = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/** Parses the allowlist file. Any deviation from the schema is invalid: unknown keys included. */
function parseSharedAllowlist(raw, counterDirectory) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const keys = Object.keys(value).sort().join(',')
  if (keys !== 'channels,expires_at,min_interval_ms_per_recipient,run_id,schema') return null
  if (value.schema !== LIVE_ACCEPTANCE_ALLOWLIST_SCHEMA_V1) return null
  if (typeof value.run_id !== 'string' || !RUN_ID.test(value.run_id)) return null
  if (typeof value.expires_at !== 'string') return null
  const expiresAtMs = Date.parse(value.expires_at)
  if (!Number.isFinite(expiresAtMs)) return null
  const minIntervalMs = value.min_interval_ms_per_recipient
  if (typeof minIntervalMs !== 'number' || !Number.isInteger(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 3_600_000) return null
  if (!isRecord(value.channels)) return null
  const channelKeys = Object.keys(value.channels)
  if (channelKeys.some(key => !LIVE_ACCEPTANCE_LANES_V1.includes(key))) return null
  const lanes = {}
  for (const lane of LIVE_ACCEPTANCE_LANES_V1) {
    const entry = value.channels[lane]
    if (entry === undefined) {
      lanes[lane] = { recipients: new Set(), maxSends: 0 }
      continue
    }
    if (!isRecord(entry)) return null
    if (Object.keys(entry).sort().join(',') !== 'max_sends,recipients') return null
    const { recipients, max_sends: maxSends } = entry
    if (!Array.isArray(recipients) || recipients.some(id => typeof id !== 'string' || id === '' || id.trim() !== id)) return null
    if (new Set(recipients).size !== recipients.length) return null
    if (typeof maxSends !== 'number' || !Number.isInteger(maxSends) || maxSends < 0 || maxSends > MAX_SENDS_LIMIT) return null
    lanes[lane] = { recipients: new Set(recipients), maxSends }
  }
  return { runId: value.run_id, expiresAtMs, expiresAt: new Date(expiresAtMs).toISOString(), minIntervalMs, counterDirectory, lanes }
}

function liveGuardRefusal(code) {
  return Object.assign(new Error(`live acceptance guard refused the send (${code})`), {
    name: 'LiveAcceptanceRefusal',
    deliveryOutcome: 'terminal',
    code,
  })
}

/** One slot per send the guard let through: `<ISO time>\t<sha256 of the recipient id>\n`. */
function parseSlot(content) {
  const match = /^([^\t\n]+)\t([0-9a-f]{64})\n$/.exec(content)
  const atMs = match ? Date.parse(match[1]) : Number.NaN
  if (!match || !Number.isFinite(atMs)) throw new Error('counter slot is malformed')
  return { atMs, recipientHash: match[2] }
}

/**
 * The shared guard. `logLanes` picks which lanes' startup lines this process
 * prints (the scraper prints only `max`). `assertRecipientAllowed` takes an
 * optional `minIntervalMs` for one call: only the MAX burst override uses it.
 */
function createLiveAcceptanceGuardV1(dependencies, { logLanes = LIVE_ACCEPTANCE_LANES_V1 } = {}) {
  const marker = dependencies.env.YOKO_LIVE_ACCEPTANCE
  if (marker === undefined || marker === '') {
    return {
      isActive: () => false,
      assertRecipientAllowed: () => undefined,
      isPeerAllowed: () => true,
      status: () => ({ mode: 'off' }),
      laneRefusal: () => null,
      recipients: () => new Set(),
      runId: () => null,
      counterDirectory: () => null,
    }
  }

  let config = null
  let startupRaw = null
  let startupRefusal = 'LIVE_GUARD_CONFIG_INVALID'
  const file = dependencies.env.YOKO_LIVE_RECIPIENT_ALLOWLIST_FILE
  const counterDirectory = dependencies.env.YOKO_LIVE_STATE_DIR
  if (marker === '1' && file && counterDirectory && path.isAbsolute(counterDirectory)) {
    let raw = null
    try {
      raw = dependencies.readFile(file)
    } catch {
      raw = null
    }
    if (raw === undefined) raw = null
    config = raw === null ? null : parseSharedAllowlist(raw, counterDirectory)
    startupRaw = raw
    if (config) {
      try {
        dependencies.ensureDirectory(counterDirectory)
        for (const lane of LIVE_ACCEPTANCE_LANES_V1) slots(config, lane)
      } catch {
        config = null
        startupRefusal = 'LIVE_GUARD_COUNTER_UNAVAILABLE'
      }
    }
  }

  function slotPrefix(active, lane) {
    return `${active.runId}.${lane}.slot-`
  }

  /** Re-read on every use, so every instance and process of the lane shares one count, across restarts. */
  function slots(active, lane) {
    return dependencies.readSlots(active.counterDirectory, slotPrefix(active, lane)).map(parseSlot)
  }

  /**
   * The file is frozen at its startup bytes: it is re-read on every check and any
   * change (emptied in place, edited, removed, unreadable) refuses everything until
   * the process restarts. It can stop sends at once and can never widen the list.
   */
  function fileChanged() {
    try {
      return dependencies.readFile(file) !== startupRaw
    } catch {
      return true
    }
  }

  /** Null when the lane may proceed to the per-recipient checks; otherwise the refusal code. */
  function laneRefusal(lane) {
    if (!config) return startupRefusal
    if (fileChanged()) return 'LIVE_GUARD_CONFIG_CHANGED'
    if (!LIVE_ACCEPTANCE_LANES_V1.includes(lane)) return 'LIVE_GUARD_CONFIG_INVALID'
    if (dependencies.now() >= config.expiresAtMs) return 'LIVE_GUARD_EXPIRED'
    if (config.lanes[lane].recipients.size === 0) return 'LIVE_GUARD_LANE_EMPTY'
    return null
  }

  const guard = {
    isActive: () => true,
    assertRecipientAllowed(lane, recipientId, kind, { minIntervalMs = null } = {}) {
      const laneCode = laneRefusal(lane)
      if (laneCode) throw liveGuardRefusal(laneCode)
      const active = config
      if (typeof recipientId !== 'string' || !active.lanes[lane].recipients.has(recipientId)) throw liveGuardRefusal('LIVE_GUARD_NOT_LISTED')
      if (kind !== 'send') {
        if (kind !== 'lookup') throw liveGuardRefusal('LIVE_GUARD_CONFIG_INVALID')
        return
      }
      const interval = Number.isInteger(minIntervalMs) ? minIntervalMs : active.minIntervalMs
      const recipientHash = sha256(recipientId)
      for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
        let taken
        try {
          taken = slots(active, lane)
        } catch {
          throw liveGuardRefusal('LIVE_GUARD_COUNTER_UNAVAILABLE')
        }
        if (taken.length >= active.lanes[lane].maxSends) throw liveGuardRefusal('LIVE_GUARD_CAP_REACHED')
        const now = dependencies.now()
        const last = taken.filter(slot => slot.recipientHash === recipientHash).reduce((max, slot) => Math.max(max, slot.atMs), Number.NEGATIVE_INFINITY)
        if (now - last < interval) throw liveGuardRefusal('LIVE_GUARD_INTERVAL')
        // Claimed before the provider call: a crash after this point still counts as a send (fail-closed).
        const slotFile = path.join(active.counterDirectory, `${slotPrefix(active, lane)}${String(taken.length + 1).padStart(4, '0')}`)
        let claimed
        try {
          claimed = dependencies.claimSlot(slotFile, `${new Date(now).toISOString()}\t${recipientHash}\n`)
        } catch {
          throw liveGuardRefusal('LIVE_GUARD_COUNTER_UNAVAILABLE')
        }
        if (claimed) return
        // Another instance took this slot first: count again.
      }
      throw liveGuardRefusal('LIVE_GUARD_COUNTER_UNAVAILABLE')
    },
    isPeerAllowed(lane, peerId) {
      if (laneRefusal(lane)) return false
      return typeof peerId === 'string' && config.lanes[lane].recipients.has(peerId)
    },
    status() {
      if (!config) return { mode: 'refuse_all', reason: startupRefusal }
      if (fileChanged()) return { mode: 'refuse_all', reason: 'LIVE_GUARD_CONFIG_CHANGED' }
      const lanes = {}
      for (const lane of LIVE_ACCEPTANCE_LANES_V1) {
        let sendsUsed
        try {
          sendsUsed = slots(config, lane).length
        } catch {
          return { mode: 'refuse_all', reason: 'LIVE_GUARD_COUNTER_UNAVAILABLE' }
        }
        lanes[lane] = { entries: config.lanes[lane].recipients.size, maxSends: config.lanes[lane].maxSends, sendsUsed }
      }
      return { mode: 'enforce', runId: config.runId, expiresAt: config.expiresAt, lanes }
    },
    laneRefusal,
    recipients: lane => (config ? new Set(config.lanes[lane]?.recipients || []) : new Set()),
    runId: () => (config ? config.runId : null),
    counterDirectory: () => (config ? config.counterDirectory : null),
  }

  // The live environment's pre-start check reads this line per lane (mode and count only, never ids).
  // Printed only when the marker is set; with the guard off nothing is logged.
  const startup = guard.status()
  for (const lane of logLanes) {
    const mode = startup.mode === 'enforce' && startup.lanes[lane].entries > 0 ? 'enforce' : 'refuse_all'
    const entries = startup.mode === 'enforce' ? startup.lanes[lane].entries : 0
    dependencies.log(`YOKO_LIVE_GUARD channel=${lane} mode=${mode} entries=${entries}`)
  }
  return guard
}

function readSlotsFromDisk(directory, prefix) {
  return fs.readdirSync(directory)
    .filter(name => name.startsWith(prefix))
    .sort()
    .map(name => fs.readFileSync(path.join(directory, name), 'utf8'))
}

function claimSlotOnDisk(file, content) {
  try {
    fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return true
  } catch (error) {
    if (isRecord(error) && error.code === 'EEXIST') return false
    throw error
  }
}

/**
 * A provider id safe for evidence and logs: in every run of five or more digits
 * only the last four stay (a phone-bearing JID, a peer or chat id); everything
 * else is kept as is. `79161234567@c.us` -> `•••••••4567@c.us`.
 */
function maskLiveProviderIdV1(id) {
  return String(id).replace(/\d{5,}/g, digits => `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}`)
}

const DISK_DEPENDENCIES = Object.freeze({
  readFile: file => fs.readFileSync(file, 'utf8'),
  ensureDirectory: directory => { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }) },
  readSlots: readSlotsFromDisk,
  claimSlot: claimSlotOnDisk,
})

// ═══ Part 2: the MAX scraper's guard ═════════════════════════════════════════

const LIVE_LANE                = 'max'
const BURST_OVERRIDE_FILE_ENV  = 'YOKO_LIVE_BURST_OVERRIDE_FILE'
const BURST_OVERRIDE_SCHEMA    = 'yoko.live-acceptance.burst-override.v1'
const BURST_MAX_SENDS          = 6
const BURST_MIN_INTERVAL_MS    = 1_000
const BURST_MAX_TTL_MS         = 10 * 60 * 1000
const PERMIT_TTL_MS            = 60_000
const OWN_FRAMES_PER_PERMIT    = 3
const PAGE_FRAMES_PER_PERMIT   = 2
const NOTED_MESSAGE_IDS_LIMIT  = 2_000
const HISTORY_MODES_ALLOWED    = new Set(['from_connection_time', 'none'])
const SCENARIO_ID              = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/

// Frames whose effect a chat member sees: a message, a deletion, a reaction.
const SEND_CLASS_OPCODES = new Set([OP.SEND_MESSAGE, OP.DELETE_MESSAGE, OP.SEND_REACTION, OP.REMOVE_REACTION])

const LIVE_INBOUND_SKIP = 'live_acceptance_not_allowlisted'

const ALLOWED_OFF = Object.freeze({ allowed: true, enforced: false })

function realIdKey(value) {
  if (value == null || value === '') return null
  // A string decodes only in canonical decimal form: no padding, sign or leading zeros.
  if (typeof value === 'string' && !/^-?[1-9]\d{0,19}$/.test(value)) return null
  const real = maxRealIdFromProtocolId(value)
  if (real === null || real === 0n) return null
  return real.toString()
}

function maskId(value) {
  return value == null || value === '' ? 'none' : maskLiveProviderIdV1(typeof value === 'bigint' ? value.toString() : String(value))
}

const PAIRING_CANDIDATES_LIMIT = 20

class MaxLiveAcceptanceGuard {
  constructor({
    env = process.env,
    historyImportMode = null,
    now = () => Date.now(),
    fsDependencies = DISK_DEPENDENCIES,
    log = console,
  } = {}) {
    this._now = now
    this._log = log
    this._fs = fsDependencies
    this._core = createLiveAcceptanceGuardV1({ env, ...fsDependencies, now, log: () => {} }, { logLanes: [] })
    this._enabled = this._core.isActive()
    if (!this._enabled) return

    this._historyRefusal = historyImportMode != null && !HISTORY_MODES_ALLOWED.has(String(historyImportMode))
      ? 'MAX_LIVE_HISTORY_MODE_NOT_ALLOWED'
      : null
    this._burstFile = typeof env[BURST_OVERRIDE_FILE_ENV] === 'string' && env[BURST_OVERRIDE_FILE_ENV] !== ''
      ? env[BURST_OVERRIDE_FILE_ENV]
      : null
    this._listedByRealId = new Map()
    for (const id of this._core.recipients(LIVE_LANE)) {
      const key = realIdKey(id)
      if (key && !this._listedByRealId.has(key)) this._listedByRealId.set(key, id)
    }
    this._active = null
    this._notedMessageIds = new Set()
    this._counts = { refused: 0, droppedInbound: 0, pageFramesDropped: 0 }
    this._tripped = this._readTripped()

    const status = this.statusSummary()
    this._log.log(`YOKO_LIVE_GUARD channel=${LIVE_LANE} mode=${status.allowlistMode} entries=${status.allowlistMode === 'enforce' ? status.entries : 0}`)
  }

  get enabled() {
    return this._enabled
  }

  // ─── Matching ──────────────────────────────────────────────────────────────

  /** The listed id this value names: the same string, or the same MAX chat in another encoding. */
  _listed(value) {
    if (value == null || value === '') return null
    const recipients = this._core.recipients(LIVE_LANE)
    if (typeof value === 'string' && recipients.has(value)) return value
    const key = realIdKey(value)
    return key ? this._listedByRealId.get(key) || null : null
  }

  // ─── Decisions ─────────────────────────────────────────────────────────────

  _refuse(code, reason) {
    this._counts.refused += 1
    return { allowed: false, enforced: true, code, reason: reason || null }
  }

  _globalRefusal() {
    const laneCode = this._core.laneRefusal(LIVE_LANE)
    if (laneCode) return this._refuse(laneCode, 'lane')
    if (this._historyRefusal) return this._refuse(this._historyRefusal, 'history mode')
    if (this._tripped) return this._refuse('MAX_LIVE_GUARD_TRIPPED', this._tripped)
    return null
  }

  /**
   * The check a request makes before anything else, so a refusal needs no
   * provider session: the configuration, the trip, the allowlist and the cap.
   * Nothing is claimed.
   */
  precheckSend(chatId) {
    if (!this._enabled) return ALLOWED_OFF
    const global = this._globalRefusal()
    if (global) return global
    const listed = this._listed(chatId)
    if (!listed) return this._refuse('LIVE_GUARD_NOT_LISTED', `chat ${maskId(chatId)}`)
    const status = this._core.status()
    if (status.mode !== 'enforce') return this._refuse(status.reason || 'LIVE_GUARD_COUNTER_UNAVAILABLE', 'status')
    const lane = status.lanes[LIVE_LANE]
    if (lane.sendsUsed >= lane.maxSends) return this._refuse('LIVE_GUARD_CAP_REACHED', `${lane.sendsUsed}/${lane.maxSends}`)
    return { allowed: true, enforced: true, listed }
  }

  /**
   * Takes the permit for one outbound action on `chatId`: the shared check
   * claims its slot (allowlist, cap, spacing) before anything reaches MAX. One
   * permit is active at a time; it ends with `endSend`.
   */
  beginSend(chatId, operation) {
    if (!this._enabled) return ALLOWED_OFF
    const pre = this.precheckSend(chatId)
    if (!pre.allowed) return pre
    const now = this._now()
    if (this._active && now <= this._active.until) {
      return this._refuse('MAX_LIVE_GUARD_BUSY', 'another permit is active')
    }
    const burst = this._burstFor(pre.listed, now)
    try {
      this._core.assertRecipientAllowed(LIVE_LANE, pre.listed, 'send', burst ? { minIntervalMs: burst.minIntervalMs } : {})
    } catch (error) {
      if (error?.name === 'LiveAcceptanceRefusal') return this._refuse(error.code, 'shared guard')
      return this._refuse('LIVE_GUARD_COUNTER_UNAVAILABLE', String(error?.message || error).slice(0, 80))
    }
    if (burst && !this._claimBurstSlot(burst)) {
      // The send's slot is already claimed: the cap stays counted, the send is refused.
      return this._refuse('MAX_LIVE_BURST_UNAVAILABLE', burst.scenario)
    }
    this._active = { listed: pre.listed, operation: String(operation || 'send'), until: now + PERMIT_TTL_MS, ownFrames: 0 }
    const burstNote = burst ? ` burst=${burst.scenario} ${burst.used + 1}/${burst.maxSends}` : ''
    this._log.log(`[liveGuard] permit op=${this._active.operation} chat=${maskId(pre.listed)}${burstNote}`)
    return { allowed: true, enforced: true }
  }

  endSend() {
    if (!this._enabled) return
    this._active = null
  }

  /**
   * In a sender, right before it acts: every id it resolved for the target
   * must be the permitted chat. A sender reached without a permit is refused.
   */
  checkTarget(...ids) {
    if (!this._enabled) return ALLOWED_OFF
    const global = this._globalRefusal()
    if (global) return global
    const active = this._active
    if (!active || this._now() > active.until) return this._refuse('MAX_LIVE_TARGET_NOT_PERMITTED', 'no active permit')
    const present = ids.filter(id => id != null && id !== '')
    if (present.length === 0) return this._refuse('MAX_LIVE_TARGET_NOT_PERMITTED', 'no target id')
    for (const id of present) {
      if (this._listed(id) !== active.listed) return this._refuse('MAX_LIVE_TARGET_NOT_PERMITTED', `target ${maskId(id)}`)
    }
    return { allowed: true, enforced: true }
  }

  /** L2: a frame the scraper builds itself, right before it is encoded. */
  checkOwnFrame(opcode, payload) {
    if (!this._enabled) return ALLOWED_OFF
    if (!SEND_CLASS_OPCODES.has(opcode)) return { allowed: true, enforced: true, sendClass: false }
    const global = this._globalRefusal()
    if (global) return { ...global, sendClass: true }
    const active = this._active
    if (!active || this._now() > active.until) return { ...this._refuse('MAX_LIVE_FRAME_NOT_ARMED', `op:${opcode}`), sendClass: true }
    if (this._listed(payload?.chatId) !== active.listed) {
      return { ...this._refuse('MAX_LIVE_FRAME_TARGET_NOT_PERMITTED', `op:${opcode} chat ${maskId(payload?.chatId)}`), sendClass: true }
    }
    if (active.ownFrames >= OWN_FRAMES_PER_PERMIT) {
      return { ...this._refuse('MAX_LIVE_FRAME_BUDGET_EXHAUSTED', `op:${opcode} after ${active.ownFrames} frames`), sendClass: true }
    }
    active.ownFrames += 1
    return { allowed: true, enforced: true, sendClass: true }
  }

  /**
   * The wire tripwire: every outgoing frame the page put on the socket, the
   * scraper's own included. A send-class request for a chat that is not listed
   * means a send escaped L1-L3, so the guard trips for the rest of the run.
   */
  observeWireFrame({ opcode, cmd, payload } = {}) {
    if (!this._enabled) return
    if (!SEND_CLASS_OPCODES.has(opcode) || cmd !== 0) return
    if (this._listed(payload?.chatId)) return
    if (this._tripped) return
    this._tripped = `wire op:${opcode} to chat ${maskId(payload?.chatId)}`
    this._writeTripped(opcode)
    this._log.error(`[liveGuard] TRIPPED: a send-class frame op:${opcode} reached the wire for a chat that is not listed (${maskId(payload?.chatId)}); every further send is refused`)
  }

  notePageFrameDropped(diag = {}) {
    if (!this._enabled) return
    this._counts.pageFramesDropped += 1
    this._log.warn(`[liveGuard] page dropped op:${diag.op ?? 'n/a'} reason:${diag.reason || 'not_armed'} total:${this._counts.pageFramesDropped}`)
  }

  // ─── The trip, on the state directory ─────────────────────────────────────

  _trippedFile() {
    const runId = this._core.runId()
    const directory = this._core.counterDirectory()
    return runId && directory ? { directory, prefix: `${runId}.${LIVE_LANE}.tripped`, file: path.join(directory, `${runId}.${LIVE_LANE}.tripped`) } : null
  }

  _readTripped() {
    const target = this._trippedFile()
    if (!target) return null
    try {
      return this._fs.readSlots(target.directory, target.prefix).length > 0 ? 'tripped earlier in this run' : null
    } catch {
      return 'trip state unreadable'
    }
  }

  _writeTripped(opcode) {
    const target = this._trippedFile()
    if (!target) return
    try {
      this._fs.claimSlot(target.file, `${new Date(this._now()).toISOString()}\top:${opcode}\n`)
    } catch (error) {
      this._log.warn(`[liveGuard] trip not written: ${error.message}`)
    }
  }

  // ─── Operator burst override (Security D2: M-05 only) ─────────────────────
  // {schema, run_id, lane:"max", scenario, recipient, max_sends <= 6,
  //  min_interval_ms >= 1000, expires_at <= 10 min ahead}, exact keys. While
  // it is valid, sends to that one listed recipient may come min_interval_ms
  // apart, and each of them claims one burst slot. One scenario per run.

  _burstFor(listed, now) {
    if (!this._burstFile) return null
    let doc
    try {
      doc = JSON.parse(this._fs.readFile(this._burstFile))
    } catch {
      return null
    }
    const runId = this._core.runId()
    const valid = isRecord(doc)
      && Object.keys(doc).sort().join(',') === 'expires_at,lane,max_sends,min_interval_ms,recipient,run_id,scenario,schema'
      && doc.schema === BURST_OVERRIDE_SCHEMA
      && doc.run_id === runId
      && doc.lane === LIVE_LANE
      && typeof doc.scenario === 'string' && SCENARIO_ID.test(doc.scenario)
      && doc.recipient === listed
      && Number.isInteger(doc.max_sends) && doc.max_sends >= 1 && doc.max_sends <= BURST_MAX_SENDS
      && Number.isInteger(doc.min_interval_ms) && doc.min_interval_ms >= BURST_MIN_INTERVAL_MS && doc.min_interval_ms <= 5_000
      && typeof doc.expires_at === 'string'
    if (!valid) return null
    const expiresAtMs = Date.parse(doc.expires_at)
    if (!Number.isFinite(expiresAtMs) || now >= expiresAtMs || expiresAtMs - now > BURST_MAX_TTL_MS) return null
    const directory = this._core.counterDirectory()
    let taken
    try {
      taken = this._fs.readSlots(directory, `${runId}.${LIVE_LANE}.burst-`)
    } catch {
      return null
    }
    // A burst slot holds `<ISO>\t<scenario>\n`: one scenario per run.
    if (taken.some(content => (String(content).split('\t')[1] || '').trim() !== doc.scenario)) {
      this._log.warn(`[liveGuard] burst override ${doc.scenario} not used: this run already used another scenario`)
      return null
    }
    const used = taken.length
    if (used >= doc.max_sends) return null
    return { scenario: doc.scenario, maxSends: doc.max_sends, minIntervalMs: doc.min_interval_ms, used, runId, directory }
  }

  _claimBurstSlot(burst) {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const used = this._fs.readSlots(burst.directory, `${burst.runId}.${LIVE_LANE}.burst-`).length
      if (used >= burst.maxSends) return false
      const file = path.join(burst.directory, `${burst.runId}.${LIVE_LANE}.burst-${burst.scenario}-${String(used + 1).padStart(4, '0')}`)
      try {
        if (this._fs.claimSlot(file, `${new Date(this._now()).toISOString()}\t${burst.scenario}\n`)) return true
      } catch {
        return false
      }
    }
    return false
  }

  // ─── Inbound ───────────────────────────────────────────────────────────────

  /** Whether a provider event of `chatId` may reach the CRM. */
  inboundAllowed(chatId) {
    if (!this._enabled) return true
    const listed = this._listed(chatId)
    if (listed && !this._historyRefusal && this._core.isPeerAllowed(LIVE_LANE, listed)) return true
    this._counts.droppedInbound += 1
    const recorded = this._recordPairingCandidate(chatId)
    this._log.warn(`[liveGuard] inbound dropped chat=${maskId(chatId)} total=${this._counts.droppedInbound}${recorded ? ' (pairing candidate recorded in the state directory)' : ''}`)
    return false
  }

  /**
   * Pairing: the first message of a new test peer is dropped like any other,
   * and its exact protocol chat id is kept in a 600 file of the state
   * directory (never in a log), where the operator reads it to list the peer.
   * At most 20 distinct chats per run.
   */
  _recordPairingCandidate(chatId) {
    const runId = this._core.runId()
    const directory = this._core.counterDirectory()
    if (!runId || !directory || chatId == null || typeof chatId === 'object') return false
    const id = String(chatId)
    if (!/^-?\d{1,20}$/.test(id)) return false
    const prefix = `${runId}.${LIVE_LANE}.candidate-`
    try {
      if (this._fs.readSlots(directory, prefix).length >= PAIRING_CANDIDATES_LIMIT) return false
      return this._fs.claimSlot(path.join(directory, `${prefix}${sha256(id).slice(0, 16)}`), `${new Date(this._now()).toISOString()}\t${id}\n`)
    } catch {
      return false
    }
  }

  /** The webhook choke: a payload of a chat that is not listed is settled locally and never posted. */
  webhookDecision(payload) {
    if (!this._enabled) return { allowed: true }
    if (this.inboundAllowed(payload?.chatId)) {
      const id = payload?.externalId
      if (id != null && id !== '') this.noteMessageId(id)
      return { allowed: true }
    }
    return {
      allowed: false,
      syntheticResult: { status: 202, data: '', json: { skipped: LIVE_INBOUND_SKIP }, skipped: LIVE_INBOUND_SKIP },
    }
  }

  noteMessageId(id) {
    if (!this._enabled || id == null || id === '') return
    this._notedMessageIds.add(String(id))
    if (this._notedMessageIds.size > NOTED_MESSAGE_IDS_LIMIT) {
      this._notedMessageIds.delete(this._notedMessageIds.values().next().value)
    }
  }

  /** A reaction event reaches the CRM only for a listed chat, or a message of one this process forwarded. */
  reactionAllowed(payload) {
    if (!this._enabled) return true
    const lanesOk = !this._core.laneRefusal(LIVE_LANE) && !this._historyRefusal
    if (lanesOk && payload?.chatId != null && this._listed(payload.chatId)) return true
    const id = payload?.externalMsgId
    if (lanesOk && id != null && this._notedMessageIds.has(String(id))) return true
    this._counts.droppedInbound += 1
    this._log.warn(`[liveGuard] reaction dropped msg=${maskId(id)} total=${this._counts.droppedInbound}`)
    return false
  }

  reactionSkipResponse() {
    return { ok: true, status: 202, skipped: LIVE_INBOUND_SKIP, json: async () => ({ skipped: LIVE_INBOUND_SKIP }) }
  }

  catchUpAllowed(chatId) {
    if (!this._enabled) return true
    const listed = this._listed(chatId)
    return Boolean(listed) && !this._historyRefusal && this._core.isPeerAllowed(LIVE_LANE, listed)
  }

  historyModeAllowed(mode) {
    if (!this._enabled) return true
    return HISTORY_MODES_ALLOWED.has(String(mode))
  }

  importHistoryAllowed() {
    return !this._enabled
  }

  // ─── Visibility ────────────────────────────────────────────────────────────

  /** What /status shows when the guard is on: mode and counts, never an id. */
  statusSummary() {
    if (!this._enabled) return null
    const status = this._core.status()
    const lane = status.mode === 'enforce' ? status.lanes[LIVE_LANE] : null
    const laneCode = this._core.laneRefusal(LIVE_LANE)
    const reason = status.mode !== 'enforce' ? status.reason : (laneCode || this._historyRefusal || (this._tripped ? 'MAX_LIVE_GUARD_TRIPPED' : null))
    return {
      allowlistMode: lane && lane.entries > 0 && !reason ? 'enforce' : 'refuse_all',
      reason: reason || null,
      entries: lane ? lane.entries : 0,
      expiresAt: status.mode === 'enforce' ? status.expiresAt : null,
      maxSends: lane ? lane.maxSends : 0,
      sendsUsed: lane ? lane.sendsUsed : 0,
      refused: this._counts.refused,
      droppedInbound: this._counts.droppedInbound,
      pageFramesDropped: this._counts.pageFramesDropped,
      tripped: Boolean(this._tripped),
    }
  }

  /** The page script for L3, or null when the guard is off (the page then runs unchanged). */
  pageInitScript() {
    return this._enabled ? LIVE_PAGE_GUARD_SCRIPT : null
  }
}

// ─── L3: the page's socket ───────────────────────────────────────────────────
// Added before WS_INIT_SCRIPT, and only when the guard is on. It wraps
// WebSocket.prototype.send, which every socket's send resolves to - the
// existing per-socket hook included, since that hook captures the prototype's
// send when the socket is created. A send-class frame passes only when the
// scraper armed it: one own frame for exactly one synchronous send
// (__maxLiveSendOwnFrame), or a short window of page frames around a UI send
// (__maxLiveArm). Typing (op:65) needs an open window. A frame whose opcode
// cannot be read is dropped.
const LIVE_PAGE_GUARD_SCRIPT = `(function () {
  var proto = window.WebSocket && window.WebSocket.prototype;
  if (!proto || proto.__maxLiveGuarded) return;
  var SEND_CLASS = { 64: 1, 66: 1, 178: 1, 179: 1 };
  var TYPING = 65;
  var MAX_PAGE_FRAMES = ${PAGE_FRAMES_PER_PERMIT};
  var MAX_WINDOW_MS = ${PERMIT_TTL_MS};
  var nativeSend = proto.send;
  var own = 0;
  var windowFrames = 0;
  var windowUntil = 0;
  function report(op, reason) {
    try { if (window.__maxWsReceive) window.__maxWsReceive(JSON.stringify({ __diag: 'live_guard_frame_dropped', op: op, reason: reason })); } catch (e) {}
  }
  function opcodeOf(data) {
    try {
      if (typeof data === 'string') {
        var parsed = JSON.parse(data);
        return parsed && typeof parsed.opcode === 'number' ? parsed.opcode : null;
      }
      var u8 = data instanceof ArrayBuffer ? new Uint8Array(data)
        : (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null);
      if (u8 && u8.length >= 10 && u8[0] === 10) return (u8[4] << 8) | u8[5];
    } catch (e) {}
    return null;
  }
  proto.send = function (data) {
    var op = opcodeOf(data);
    if (op === null) { report(null, 'unclassified_frame'); return; }
    if (SEND_CLASS[op]) {
      if (own > 0) { own -= 1; }
      else if (windowFrames > 0 && Date.now() <= windowUntil) { windowFrames -= 1; }
      else { report(op, 'not_armed'); return; }
    } else if (op === TYPING) {
      if (!(own > 0 || Date.now() <= windowUntil)) { report(op, 'typing_not_armed'); return; }
    }
    return nativeSend.apply(this, arguments);
  };
  Object.defineProperty(proto, '__maxLiveGuarded', { value: true });
  window.__maxLiveArm = function () {
    windowFrames = MAX_PAGE_FRAMES;
    windowUntil = Date.now() + MAX_WINDOW_MS;
    return true;
  };
  window.__maxLiveDisarm = function () {
    windowFrames = 0;
    windowUntil = 0;
    return true;
  };
  window.__maxLiveSendOwnFrame = function (send) {
    own = 1;
    try { return send(); } finally { own = 0; }
  };
})();`

function liveRefusalError(decision) {
  return Object.assign(new Error(`${decision.code}: nothing was dispatched (MAX_SEND_REFUSED)`), {
    liveRefused: true,
    code: decision.code,
    reason: decision.reason || null,
    dispatched: false,
  })
}

function liveRefusalBody(decision) {
  return {
    success: false,
    code: decision.code,
    outcomeClass: 'MAX_SEND_REFUSED',
    reason: decision.reason || null,
    error: `${decision.code}: nothing was dispatched (MAX_SEND_REFUSED)`,
  }
}

module.exports = {
  // Part 1: the shared reader
  LIVE_ACCEPTANCE_ALLOWLIST_SCHEMA_V1,
  LIVE_ACCEPTANCE_LANES_V1,
  LIVE_GUARD_CODES,
  createLiveAcceptanceGuardV1,
  maskLiveProviderIdV1,
  readSlotsFromDisk,
  claimSlotOnDisk,
  // Part 2: the MAX scraper
  MaxLiveAcceptanceGuard,
  BURST_OVERRIDE_FILE_ENV,
  BURST_OVERRIDE_SCHEMA,
  LIVE_INBOUND_SKIP,
  LIVE_PAGE_GUARD_SCRIPT,
  SEND_CLASS_OPCODES,
  BURST_MAX_SENDS,
  BURST_MIN_INTERVAL_MS,
  BURST_MAX_TTL_MS,
  PERMIT_TTL_MS,
  OWN_FRAMES_PER_PERMIT,
  PAGE_FRAMES_PER_PERMIT,
  liveRefusalError,
  liveRefusalBody,
}
