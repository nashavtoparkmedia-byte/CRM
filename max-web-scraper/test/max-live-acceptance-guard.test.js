'use strict'

// PR-MAX-LIVE-1: the live-acceptance recipient guard of the MAX scraper
// (lib/LiveAcceptanceGuard.js). Part 1 is the shared reader of
// yoko.live-acceptance.recipient-allowlist.v1 and answers the shared
// conformance vectors; part 2 is the scraper's use of it. Chat ids here are
// synthetic: protocol id = (0xd2 << 32) | real id.

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const {
  createLiveAcceptanceGuardV1,
  maskLiveProviderIdV1,
  MaxLiveAcceptanceGuard,
  LIVE_PAGE_GUARD_SCRIPT,
} = require('../lib/LiveAcceptanceGuard')
const { TransportInterceptor, WS_INIT_SCRIPT, OP } = require('../transport/TransportInterceptor')

const repoRoot = path.resolve(__dirname, '..', '..')
const read = relPath => fs.readFileSync(path.join(repoRoot, relPath), 'utf8')
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')

// ─── Part 1: the shared conformance vectors ──────────────────────────────────

const VECTORS_FIXTURE = 'max-web-scraper/test/fixtures/live-acceptance-recipient-guard.vectors.json'
const VECTORS_GRAVITY = 'gravity-mvp/src/modules/messaging/public/v1/live-acceptance-recipient-guard.vectors.json'
const vectors = JSON.parse(read(VECTORS_FIXTURE))
const expandSha = content => content.replace(/__SHA256\(([^)]*)\)__/g, (_, value) => sha256(value))

/** An in-memory file system with the disk adapter's semantics (exclusive create). */
function memoryFs({ files = {}, directories = [] } = {}) {
  const store = new Map(Object.entries(files))
  const dirs = new Set(directories)
  return {
    store,
    dirs,
    deps: {
      readFile(file) {
        const content = store.get(file)
        if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return content
      },
      ensureDirectory(directory) { dirs.add(directory) },
      readSlots(directory, prefix) {
        return [...store.entries()]
          .filter(([file]) => path.dirname(file) === directory && path.basename(file).startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, content]) => content)
      },
      claimSlot(file, content) {
        if (store.has(file)) return false
        store.set(file, content)
        return true
      },
    },
  }
}

function vectorFs(vector) {
  const files = {}
  const allowlistFile = vector.env.YOKO_LIVE_RECIPIENT_ALLOWLIST_FILE
  if (allowlistFile && vector.allowlist !== null && vector.allowlist !== undefined) {
    files[allowlistFile] = typeof vector.allowlist === 'string' ? vector.allowlist : JSON.stringify(vector.allowlist)
  }
  for (const [name, content] of Object.entries(vector.counters ?? {})) {
    files[path.join(vector.env.YOKO_LIVE_STATE_DIR, name)] = expandSha(content)
  }
  return memoryFs({ files })
}

function outcome(run) {
  try {
    run()
    return 'allow'
  } catch (error) {
    assert.equal(error.name, 'LiveAcceptanceRefusal', String(error?.stack || error))
    assert.equal(error.deliveryOutcome, 'terminal')
    return error.code
  }
}

test('the scraper carries the shared vectors file, byte-identical to the gravity copy when it is present', () => {
  assert.equal(vectors.schema, 'yoko.live-acceptance.recipient-guard-vectors.v1')
  assert.ok(vectors.cases.length >= 25)
  if (fs.existsSync(path.join(repoRoot, VECTORS_GRAVITY))) {
    assert.equal(read(VECTORS_FIXTURE), read(VECTORS_GRAVITY), 'the two copies of the shared vectors must not drift')
  }
})

for (const vector of vectors.cases) {
  test(`shared vector: ${vector.name}`, () => {
    const clock = { now: Date.parse(vector.steps[0]?.at ?? '2026-11-12T09:00:00.000Z') }
    const memory = vectorFs(vector)
    const log = []
    const guard = createLiveAcceptanceGuardV1({ env: vector.env, ...memory.deps, log: line => log.push(line), now: () => clock.now })
    if (vector.startup_log) assert.deepEqual(log, vector.startup_log)
    for (const step of vector.steps) {
      clock.now = Date.parse(step.at)
      if (step.op === 'write_allowlist') {
        const file = vector.env.YOKO_LIVE_RECIPIENT_ALLOWLIST_FILE
        if (step.content === null) memory.store.delete(file)
        else memory.store.set(file, typeof step.content === 'string' ? step.content : JSON.stringify(step.content))
      } else if (step.op === 'peer') {
        assert.equal(guard.isPeerAllowed(step.lane, step.id) ? 'allow' : 'refuse', step.expect, `${step.lane} ${step.id}`)
      } else if (step.op === 'status') {
        const status = guard.status()
        if (step.expect !== undefined) assert.deepEqual(status, step.expect)
        if (step.expect_lane) {
          assert.equal(status.mode, 'enforce')
          assert.equal(status.lanes[step.expect_lane.lane].sendsUsed, step.expect_lane.sendsUsed)
        }
      } else {
        const kind = step.op === 'assert' ? step.kind : step.op
        assert.equal(outcome(() => guard.assertRecipientAllowed(step.lane, step.id, kind)), step.expect, `${step.op} ${step.lane} ${step.id} at ${step.at}`)
      }
    }
  })
}

const ON_ENV = { YOKO_LIVE_ACCEPTANCE: '1', YOKO_LIVE_RECIPIENT_ALLOWLIST_FILE: '/run/yoko-live/allowlist.json', YOKO_LIVE_STATE_DIR: '/live/state' }

test('shared core: two instances over one state directory share the cap, and a lost slot race recounts', () => {
  const allowlist = { schema: 'yoko.live-acceptance.recipient-allowlist.v1', run_id: 'LIVE-T-02', expires_at: '2026-11-12T18:00:00.000Z', min_interval_ms_per_recipient: 0, channels: { max: { recipients: ['90000001', '90000002'], max_sends: 3 } } }
  const memory = memoryFs({ files: { [ON_ENV.YOKO_LIVE_RECIPIENT_ALLOWLIST_FILE]: JSON.stringify(allowlist) } })
  const now = () => Date.parse('2026-11-12T09:00:00.000Z')
  const first = createLiveAcceptanceGuardV1({ env: ON_ENV, ...memory.deps, log: () => {}, now })
  const second = createLiveAcceptanceGuardV1({ env: ON_ENV, ...memory.deps, log: () => {}, now })
  assert.equal(outcome(() => first.assertRecipientAllowed('max', '90000001', 'send')), 'allow')
  assert.equal(outcome(() => second.assertRecipientAllowed('max', '90000002', 'send')), 'allow')
  assert.equal(outcome(() => first.assertRecipientAllowed('max', '90000002', 'send')), 'allow')
  assert.equal(outcome(() => second.assertRecipientAllowed('max', '90000001', 'send')), 'LIVE_GUARD_CAP_REACHED')
  const racing = createLiveAcceptanceGuardV1({
    env: ON_ENV,
    ...memory.deps,
    claimSlot: () => false,
    log: () => {},
    now,
  })
  memory.store.delete('/live/state/LIVE-T-02.max.slot-0003')
  assert.equal(outcome(() => racing.assertRecipientAllowed('max', '90000001', 'send')), 'LIVE_GUARD_COUNTER_UNAVAILABLE', 'a slot that can never be claimed refuses')
})

test('the shared id mask keeps only the last four digits of each long run', () => {
  assert.equal(maskLiveProviderIdV1('79161234567@c.us'), '•••••••4567@c.us')
  assert.equal(maskLiveProviderIdV1('901944132161'), '••••••••2161')
  assert.equal(maskLiveProviderIdV1('1234'), '1234')
})

// ─── Part 2: the scraper's guard ─────────────────────────────────────────────

const PROTOCOL_PREFIX = 0xd2n << 32n
const protocolId = real => (PROTOCOL_PREFIX | BigInt(real)).toString()
const B_REAL = 1000001
const C_REAL = 2000002
const D_REAL = 3000003
const B = protocolId(B_REAL)
const C = protocolId(C_REAL)
const D = protocolId(D_REAL)
const ALLOWLIST_FILE = ON_ENV.YOKO_LIVE_RECIPIENT_ALLOWLIST_FILE
const BURST_FILE = '/run/yoko-live/max-burst.json'
const STATE_DIR = ON_ENV.YOKO_LIVE_STATE_DIR
const RUN = 'LIVE-M-01'
const START = Date.parse('2026-11-12T09:00:00.000Z')

function allowlistDoc({ recipients = [B, D], maxSends = 10, minIntervalMs = 5000, expiresAt = '2026-11-12T18:00:00.000Z', channels = null } = {}) {
  return JSON.stringify({
    schema: 'yoko.live-acceptance.recipient-allowlist.v1',
    run_id: RUN,
    expires_at: expiresAt,
    min_interval_ms_per_recipient: minIntervalMs,
    channels: channels || { max: { recipients, max_sends: maxSends } },
  })
}

function clock(start = START) {
  let now = start
  return { now: () => now, advance(ms) { now += ms }, set(ms) { now = ms } }
}

function recordingLog() {
  const lines = []
  return { lines, log: line => lines.push(String(line)), warn: line => lines.push(String(line)), error: line => lines.push(String(line)) }
}

function maxGuard({ allowlist = allowlistDoc(), env = {}, time = clock(), memory = null, historyImportMode = 'from_connection_time', extraFiles = {} } = {}) {
  const fsMemory = memory || memoryFs({ files: { ...(allowlist === null ? {} : { [ALLOWLIST_FILE]: allowlist }), ...extraFiles } })
  const log = recordingLog()
  const guard = new MaxLiveAcceptanceGuard({ env: { ...ON_ENV, ...env }, historyImportMode, now: time.now, fsDependencies: fsMemory.deps, log })
  return { guard, memory: fsMemory, time, log }
}

const offGuard = () => new MaxLiveAcceptanceGuard({ env: {}, fsDependencies: memoryFs().deps, log: recordingLog() })

test('OFF: every check allows; nothing is read, written or logged; no page script; no status block', () => {
  for (const env of [{}, { YOKO_LIVE_ACCEPTANCE: '' }]) {
    const memory = memoryFs()
    const touched = []
    const deps = Object.fromEntries(Object.entries(memory.deps).map(([name, fn]) => [name, (...args) => { touched.push(name); return fn(...args) }]))
    const log = recordingLog()
    const guard = new MaxLiveAcceptanceGuard({ env, historyImportMode: 'available_history', fsDependencies: deps, log })
    assert.equal(guard.enabled, false)
    assert.deepEqual(guard.precheckSend(C), { allowed: true, enforced: false })
    assert.deepEqual(guard.beginSend(C, 'send_text'), { allowed: true, enforced: false })
    assert.deepEqual(guard.checkTarget(C, '123'), { allowed: true, enforced: false })
    assert.deepEqual(guard.checkOwnFrame(OP.SEND_MESSAGE, { chatId: BigInt(C_REAL) }), { allowed: true, enforced: false })
    guard.observeWireFrame({ opcode: OP.SEND_MESSAGE, cmd: 0, payload: { chatId: BigInt(C_REAL) } })
    guard.endSend()
    guard.notePageFrameDropped({ op: 64 })
    assert.equal(guard.inboundAllowed(C), true)
    assert.deepEqual(guard.webhookDecision({ chatId: C, externalId: 'x' }), { allowed: true })
    assert.equal(guard.reactionAllowed({ externalMsgId: 'unknown' }), true)
    assert.equal(guard.catchUpAllowed(C), true)
    assert.equal(guard.historyModeAllowed('available_history'), true)
    assert.equal(guard.importHistoryAllowed(), true)
    assert.equal(guard.statusSummary(), null)
    assert.equal(guard.pageInitScript(), null)
    assert.deepEqual(touched, [])
    assert.deepEqual(log.lines, [])
  }
})

test('ON: one startup line for the max lane, enforce only with a valid list naming MAX recipients', () => {
  assert.deepEqual(maxGuard().log.lines, ['YOKO_LIVE_GUARD channel=max mode=enforce entries=2'])
  const refused = [
    maxGuard({ allowlist: null }),
    maxGuard({ allowlist: '{not json' }),
    maxGuard({ allowlist: allowlistDoc({ recipients: [] }) }),
    maxGuard({ allowlist: allowlistDoc({ channels: { whatsapp: { recipients: ['70000000001@c.us'], max_sends: 1 } } }) }),
    maxGuard({ env: { YOKO_LIVE_ACCEPTANCE: 'on' } }),
    maxGuard({ env: { YOKO_LIVE_STATE_DIR: 'relative' } }),
    maxGuard({ historyImportMode: 'available_history' }),
    maxGuard({ allowlist: allowlistDoc({ expiresAt: '2026-11-12T08:00:00.000Z' }) }),
  ]
  for (const { log, guard } of refused) {
    assert.deepEqual(log.lines, ['YOKO_LIVE_GUARD channel=max mode=refuse_all entries=0'])
    assert.equal(guard.enabled, true)
    assert.equal(guard.precheckSend(B).allowed, false)
    assert.equal(guard.beginSend(B, 'send_text').allowed, false)
    assert.equal(guard.inboundAllowed(B), false)
    assert.equal(guard.catchUpAllowed(B), false)
    assert.equal(guard.statusSummary().allowlistMode, 'refuse_all')
  }
  assert.equal(refused[4].guard.precheckSend(B).code, 'LIVE_GUARD_CONFIG_INVALID', 'a marker other than 1 refuses everything')
  assert.equal(refused[6].guard.precheckSend(B).code, 'MAX_LIVE_HISTORY_MODE_NOT_ALLOWED')
  assert.equal(refused[7].guard.precheckSend(B).code, 'LIVE_GUARD_EXPIRED')
})

test('ON: the listed protocol id gets a permit; its web route and its page BigInt name the same chat; others are not listed', () => {
  const { guard } = maxGuard()
  assert.equal(guard.precheckSend(C).code, 'LIVE_GUARD_NOT_LISTED')
  assert.equal(guard.precheckSend('').code, 'LIVE_GUARD_NOT_LISTED')
  assert.equal(guard.precheckSend('-1000001').code, 'LIVE_GUARD_NOT_LISTED', 'a group is refused unless listed')
  assert.equal(guard.precheckSend(`${B} `).code, 'LIVE_GUARD_NOT_LISTED', 'no padding')
  assert.equal(guard.precheckSend(`${B}0`).code, 'LIVE_GUARD_NOT_LISTED', 'no suffix logic')
  assert.equal(guard.precheckSend(`0${B}`).code, 'LIVE_GUARD_NOT_LISTED', 'no leading zeros')
  assert.equal(guard.precheckSend(` ${B_REAL}`).code, 'LIVE_GUARD_NOT_LISTED', 'a padded web route does not decode')
  assert.equal(guard.precheckSend(String(B_REAL)).allowed, true, 'web route of B')
  assert.equal(guard.precheckSend(BigInt(B_REAL)).allowed, true, 'real id of B as the page sends it')
  assert.equal(guard.beginSend(B, 'send_text').allowed, true)
})

test('ON: each permit claims one shared slot before the action; the cap and the spacing come from the file and survive a restart', () => {
  const time = clock()
  const { guard, memory } = maxGuard({ allowlist: allowlistDoc({ maxSends: 3 }), time })
  for (let i = 0; i < 3; i++) {
    assert.equal(guard.beginSend(B, 'send_text').allowed, true)
    guard.endSend()
    time.advance(6_000)
  }
  assert.equal(guard.beginSend(D, 'send_text').code, 'LIVE_GUARD_CAP_REACHED')
  const slots = [...memory.store.keys()].filter(file => file.startsWith(`${STATE_DIR}/${RUN}.max.slot-`)).sort()
  assert.deepEqual(slots, [1, 2, 3].map(n => `${STATE_DIR}/${RUN}.max.slot-000${n}`))
  assert.match(memory.store.get(slots[0]), new RegExp(`^2026-11-12T09:00:00.000Z\\t${sha256(B)}\\n$`), 'the slot names the listed id by its hash')
  const restarted = maxGuard({ memory, time })
  assert.equal(restarted.guard.precheckSend(B).code, 'LIVE_GUARD_CAP_REACHED')
  assert.equal(restarted.guard.statusSummary().sendsUsed, 3)

  const spacing = maxGuard({ time: clock() })
  assert.equal(spacing.guard.beginSend(B, 'send_text').allowed, true)
  spacing.guard.endSend()
  spacing.time.advance(4_999)
  assert.equal(spacing.guard.beginSend(String(B_REAL), 'send_text').code, 'LIVE_GUARD_INTERVAL', 'the web route of B is spaced with B')
  assert.equal(spacing.guard.beginSend(D, 'send_text').allowed, true, 'another recipient is not slowed')
  spacing.guard.endSend()
  spacing.time.advance(1)
  assert.equal(spacing.guard.beginSend(B, 'send_text').allowed, true)
})

test('ON: the kill switch empties the allowlist in place and every MAX check refuses at once, without a restart', () => {
  const { guard, memory } = maxGuard()
  assert.equal(guard.beginSend(B, 'send_text').allowed, true, 'a permit is active when the file is emptied')
  memory.store.set(ALLOWLIST_FILE, '')
  assert.equal(guard.checkTarget(B).code, 'LIVE_GUARD_CONFIG_CHANGED', 'the sender of the active permit is stopped')
  assert.equal(guard.checkOwnFrame(OP.SEND_MESSAGE, { chatId: BigInt(B_REAL) }).code, 'LIVE_GUARD_CONFIG_CHANGED')
  guard.endSend()
  assert.equal(guard.precheckSend(B).code, 'LIVE_GUARD_CONFIG_CHANGED')
  assert.equal(guard.beginSend(D, 'send_text').code, 'LIVE_GUARD_CONFIG_CHANGED')
  assert.equal(guard.inboundAllowed(B), false)
  assert.equal(guard.catchUpAllowed(B), false)
  assert.equal(guard.reactionAllowed({ externalMsgId: 'x', chatId: B }), false)
  assert.equal(guard.statusSummary().allowlistMode, 'refuse_all')
  assert.equal(guard.statusSummary().reason, 'LIVE_GUARD_CONFIG_CHANGED')
})

test('ON: a refused permit claims no slot, and one permit is active at a time', () => {
  const { guard, memory } = maxGuard()
  assert.equal(guard.beginSend(C, 'send_text').code, 'LIVE_GUARD_NOT_LISTED')
  assert.equal([...memory.store.keys()].filter(file => file.includes('.slot-')).length, 0)
  assert.equal(guard.beginSend(B, 'send_text').allowed, true)
  assert.equal(guard.beginSend(D, 'send_text').code, 'MAX_LIVE_GUARD_BUSY')
  guard.endSend()
  assert.equal(guard.beginSend(D, 'send_text').allowed, true)
})

// ─── The M-05 burst override (Security D2) ────────────────────────────────────

function burstDoc(time, overrides = {}) {
  return JSON.stringify({
    schema: 'yoko.live-acceptance.burst-override.v1',
    run_id: RUN,
    lane: 'max',
    scenario: 'M-05',
    recipient: B,
    max_sends: 6,
    min_interval_ms: 1000,
    expires_at: new Date(time.now() + 5 * 60_000).toISOString(),
    ...overrides,
  })
}

test('burst: exactly six sends to its recipient at least 1 s apart, each a lane slot plus a burst slot', () => {
  const time = clock()
  const { guard, memory } = maxGuard({ env: { YOKO_LIVE_BURST_OVERRIDE_FILE: BURST_FILE }, time, extraFiles: { [BURST_FILE]: burstDoc(time) } })
  for (let i = 0; i < 6; i++) {
    assert.equal(guard.beginSend(B, 'send_text').allowed, true, `burst send ${i + 1}`)
    guard.endSend()
    time.advance(1_000)
  }
  assert.equal(guard.beginSend(B, 'send_text').code, 'LIVE_GUARD_INTERVAL', 'a seventh send 1 s later is refused')
  const files = [...memory.store.keys()]
  assert.equal(files.filter(file => file.startsWith(`${STATE_DIR}/${RUN}.max.slot-`)).length, 6)
  assert.equal(files.filter(file => file.startsWith(`${STATE_DIR}/${RUN}.max.burst-M-05-`)).length, 6)
  time.advance(4_000)
  assert.equal(guard.beginSend(B, 'send_text').allowed, true, 'the file spacing applies again')
  guard.endSend()
  const restarted = maxGuard({ memory, time, env: { YOKO_LIVE_BURST_OVERRIDE_FILE: BURST_FILE } })
  time.advance(1_000)
  assert.equal(restarted.guard.beginSend(B, 'send_text').code, 'LIVE_GUARD_INTERVAL', 'a used-up burst stays used across a restart')
})

test('burst: keeps its own spacing, is only for its recipient, and stays inside the lane cap', () => {
  const time = clock()
  const { guard } = maxGuard({ allowlist: allowlistDoc({ maxSends: 3 }), env: { YOKO_LIVE_BURST_OVERRIDE_FILE: BURST_FILE }, time, extraFiles: { [BURST_FILE]: burstDoc(time) } })
  assert.equal(guard.beginSend(B, 'send_text').allowed, true)
  guard.endSend()
  time.advance(999)
  assert.equal(guard.beginSend(B, 'send_text').code, 'LIVE_GUARD_INTERVAL')
  assert.equal(guard.beginSend(D, 'send_text').allowed, true)
  guard.endSend()
  time.advance(1_000)
  assert.equal(guard.beginSend(D, 'send_text').code, 'LIVE_GUARD_INTERVAL', 'D keeps the 5 s spacing')
  assert.equal(guard.beginSend(B, 'send_text').allowed, true)
  guard.endSend()
  time.advance(1_000)
  assert.equal(guard.beginSend(B, 'send_text').code, 'LIVE_GUARD_CAP_REACHED')
})

test('burst: an override that is malformed, expired, too long, too large, too fast, for another run or recipient, or a second scenario is not used', () => {
  const invalid = [
    time => burstDoc(time, { expires_at: new Date(time.now() - 1).toISOString() }),
    time => burstDoc(time, { expires_at: new Date(time.now() + 11 * 60_000).toISOString() }),
    time => burstDoc(time, { max_sends: 7 }),
    time => burstDoc(time, { min_interval_ms: 999 }),
    time => burstDoc(time, { recipient: D }),
    time => burstDoc(time, { recipient: String(B_REAL) }),
    time => burstDoc(time, { run_id: 'LIVE-OTHER' }),
    time => burstDoc(time, { lane: 'whatsapp' }),
    time => burstDoc(time, { scenario: 'M 05' }),
    time => burstDoc(time, { schema: 'yoko.other.v1' }),
    time => JSON.stringify({ ...JSON.parse(burstDoc(time)), extra: 1 }),
    () => '{not json',
  ]
  for (const variant of invalid) {
    const time = clock()
    const { guard } = maxGuard({ env: { YOKO_LIVE_BURST_OVERRIDE_FILE: BURST_FILE }, time, extraFiles: { [BURST_FILE]: variant(time) } })
    assert.equal(guard.beginSend(B, 'send_text').allowed, true)
    guard.endSend()
    time.advance(1_000)
    assert.equal(guard.beginSend(B, 'send_text').code, 'LIVE_GUARD_INTERVAL')
  }

  const time = clock()
  const { guard, memory } = maxGuard({ env: { YOKO_LIVE_BURST_OVERRIDE_FILE: BURST_FILE }, time, extraFiles: { [BURST_FILE]: burstDoc(time, { max_sends: 2 }) } })
  assert.equal(guard.beginSend(B, 'send_text').allowed, true)
  guard.endSend()
  time.advance(1_000)
  assert.equal(guard.beginSend(B, 'send_text').allowed, true)
  guard.endSend()
  memory.store.set(BURST_FILE, burstDoc(time, { scenario: 'M-05b' }))
  time.advance(1_000)
  assert.equal(guard.beginSend(B, 'send_text').code, 'LIVE_GUARD_INTERVAL', 'one scenario per run')
})

// ─── The target a sender resolved, its frames, the wire ──────────────────────

test('ON: a sender may act only on the permitted chat, and only while the permit is open', () => {
  const time = clock()
  const { guard } = maxGuard({ time })
  assert.equal(guard.checkTarget(B).code, 'MAX_LIVE_TARGET_NOT_PERMITTED', 'no permit')
  guard.beginSend(B, 'send_media')
  assert.equal(guard.checkTarget(B, String(B_REAL)).allowed, true, 'B and its web route')
  assert.equal(guard.checkTarget(B, String(D_REAL)).code, 'MAX_LIVE_TARGET_NOT_PERMITTED', 'a route resolved to another listed chat')
  assert.equal(guard.checkTarget(C).code, 'MAX_LIVE_TARGET_NOT_PERMITTED')
  assert.equal(guard.checkTarget().code, 'MAX_LIVE_TARGET_NOT_PERMITTED')
  time.advance(60_001)
  assert.equal(guard.checkTarget(B).code, 'MAX_LIVE_TARGET_NOT_PERMITTED', 'the permit expired')
  guard.endSend()
})

test('ON: own send-class frames pass only for the permitted chat, at most three per permit', () => {
  const { guard } = maxGuard()
  assert.deepEqual(guard.checkOwnFrame(OP.GET_HISTORY, { chatId: BigInt(C_REAL) }), { allowed: true, enforced: true, sendClass: false })
  assert.equal(guard.checkOwnFrame(OP.SEND_MESSAGE, { chatId: BigInt(B_REAL) }).code, 'MAX_LIVE_FRAME_NOT_ARMED')
  guard.beginSend(B, 'send_image')
  assert.equal(guard.checkOwnFrame(OP.SEND_MESSAGE, { chatId: BigInt(C_REAL) }).code, 'MAX_LIVE_FRAME_TARGET_NOT_PERMITTED')
  for (const opcode of [OP.SEND_MESSAGE, OP.SEND_REACTION, OP.DELETE_MESSAGE]) {
    assert.equal(guard.checkOwnFrame(opcode, { chatId: BigInt(B_REAL) }).allowed, true)
  }
  assert.equal(guard.checkOwnFrame(OP.REMOVE_REACTION, { chatId: BigInt(B_REAL) }).code, 'MAX_LIVE_FRAME_BUDGET_EXHAUSTED')
  guard.endSend()
  assert.equal(guard.checkOwnFrame(OP.SEND_MESSAGE, { chatId: BigInt(B_REAL) }).code, 'MAX_LIVE_FRAME_NOT_ARMED')
})

test('ON: a send-class request on the wire to a chat that is not listed trips the guard for the rest of the run', () => {
  const time = clock()
  const { guard, memory } = maxGuard({ time })
  guard.observeWireFrame({ opcode: OP.SEND_MESSAGE, cmd: 0, payload: { chatId: BigInt(B_REAL) } })
  guard.observeWireFrame({ opcode: OP.SEND_MESSAGE, cmd: 1, payload: { chatId: BigInt(C_REAL) } })
  guard.observeWireFrame({ opcode: OP.GET_HISTORY, cmd: 0, payload: { chatId: BigInt(C_REAL) } })
  assert.equal(guard.precheckSend(B).allowed, true)
  guard.observeWireFrame({ opcode: OP.SEND_MESSAGE, cmd: 0, payload: { chatId: BigInt(C_REAL) } })
  assert.equal(guard.precheckSend(B).code, 'MAX_LIVE_GUARD_TRIPPED')
  assert.equal(guard.statusSummary().tripped, true)
  assert.equal(guard.statusSummary().allowlistMode, 'refuse_all')
  assert.ok(memory.store.has(`${STATE_DIR}/${RUN}.max.tripped`))
  const restarted = maxGuard({ memory, time })
  assert.equal(restarted.guard.precheckSend(B).code, 'MAX_LIVE_GUARD_TRIPPED')
  assert.deepEqual(restarted.log.lines, ['YOKO_LIVE_GUARD channel=max mode=refuse_all entries=0'])
})

// ─── Inbound ─────────────────────────────────────────────────────────────────

test('ON: inbound from a chat that is not listed is settled locally, counted, never posted; pairing keeps its id in a state file, not the log', () => {
  const { guard, memory, log } = maxGuard()
  assert.equal(guard.inboundAllowed(B), true)
  assert.equal(guard.inboundAllowed(String(B_REAL)), true, 'the same chat by its web route')
  assert.equal(guard.inboundAllowed(C), false)
  assert.equal(guard.inboundAllowed(null), false)
  const dropped = guard.webhookDecision({ chatId: C, externalId: 'd301ccc', text: 'hello' })
  assert.equal(dropped.allowed, false)
  assert.equal(dropped.syntheticResult.status, 202)
  assert.equal(dropped.syntheticResult.skipped, 'live_acceptance_not_allowlisted')
  assert.equal(guard.statusSummary().droppedInbound, 3)
  const candidates = [...memory.store.entries()].filter(([file]) => file.startsWith(`${STATE_DIR}/${RUN}.max.candidate-`))
  assert.equal(candidates.length, 1, 'one candidate file per chat')
  assert.match(candidates[0][1], new RegExp(`\\t${C}\\n$`))
  for (const line of log.lines) assert.equal(line.includes(C), false, `no full chat id in the log: ${line}`)
  for (let i = 0; i < 30; i++) guard.inboundAllowed(protocolId(4000000 + i))
  assert.equal([...memory.store.keys()].filter(file => file.includes('.candidate-')).length, 20, 'at most 20 candidates per run')
})

test('ON: a reaction reaches the CRM only for a listed chat or a message of one that was forwarded', () => {
  const { guard } = maxGuard()
  assert.equal(guard.reactionAllowed({ externalMsgId: 'd301bbb', counters: [] }), false)
  assert.deepEqual(guard.webhookDecision({ chatId: B, externalId: 'd301bbb' }), { allowed: true })
  assert.equal(guard.reactionAllowed({ externalMsgId: 'd301bbb', counters: [] }), true)
  assert.equal(guard.reactionAllowed({ externalMsgId: 'd301zzz', chatId: B }), true)
  assert.equal(guard.reactionAllowed({ externalMsgId: 'd301zzz', chatId: C }), false)
  const skip = guard.reactionSkipResponse()
  assert.equal(skip.ok, true)
  assert.equal(skip.status, 202)
})

test('ON: catch-up and history are scoped to the list and to from_connection_time/none', () => {
  const { guard } = maxGuard()
  assert.equal(guard.catchUpAllowed(B), true)
  assert.equal(guard.catchUpAllowed(C), false)
  assert.equal(guard.historyModeAllowed('from_connection_time'), true)
  assert.equal(guard.historyModeAllowed('none'), true)
  assert.equal(guard.historyModeAllowed('available_history'), false)
  assert.equal(guard.importHistoryAllowed(), false)
})

test('ON: /status shows the mode and counts, never an id or the run label', () => {
  const { guard } = maxGuard()
  guard.beginSend(B, 'send_text')
  guard.endSend()
  guard.inboundAllowed(C)
  const summary = guard.statusSummary()
  assert.equal(summary.allowlistMode, 'enforce')
  assert.equal(summary.entries, 2)
  assert.equal(summary.sendsUsed, 1)
  assert.equal(summary.maxSends, 10)
  const text = JSON.stringify(summary)
  for (const id of [B, C, D, String(B_REAL), String(C_REAL), RUN]) assert.equal(text.includes(id), false, id)
})

// ─── L3: the page's socket ───────────────────────────────────────────────────

function frame(opcode, version = 10) {
  const bytes = new Uint8Array(12)
  bytes[0] = version
  bytes[4] = (opcode >> 8) & 0xff
  bytes[5] = opcode & 0xff
  return bytes.buffer
}

function opcodeOfSent(data) {
  if (typeof data === 'string') return JSON.parse(data).opcode
  const u8 = new Uint8Array(data)
  return (u8[4] << 8) | u8[5]
}

function browser() {
  const sent = []
  const diags = []
  class FakeWebSocket {
    constructor(url) { this.url = url; this.readyState = 1; this.listeners = {} }
    addEventListener(type, fn) { this.listeners[type] = fn }
  }
  FakeWebSocket.prototype.send = function (data) { sent.push(data) }
  FakeWebSocket.CONNECTING = 0
  FakeWebSocket.OPEN = 1
  FakeWebSocket.CLOSING = 2
  FakeWebSocket.CLOSED = 3
  const sandbox = { WebSocket: FakeWebSocket, ArrayBuffer, Uint8Array, JSON, Date, atob, btoa, Object, String, Math }
  sandbox.window = sandbox
  sandbox.__maxWsReceive = text => diags.push(JSON.parse(text))
  vm.createContext(sandbox)
  return { window: sandbox, sent, diags, run: source => vm.runInContext(source, sandbox) }
}

test('L3: the page drops send-class frames nobody armed and passes everything else', () => {
  const page = browser()
  page.run(LIVE_PAGE_GUARD_SCRIPT)
  const ws = new page.window.WebSocket('wss://ws-api.oneme.ru/websocket')
  ws.send(frame(OP.SEND_MESSAGE))
  ws.send(frame(OP.SEND_REACTION))
  ws.send(JSON.stringify({ ver: 11, opcode: 64, payload: {} }))
  ws.send(frame(OP.TYPING))
  ws.send(frame(OP.GET_HISTORY))
  ws.send(frame(1))
  ws.send(frame(OP.SEND_MESSAGE, 9))
  ws.send('ping')
  assert.deepEqual(page.sent.map(opcodeOfSent), [OP.GET_HISTORY, 1])
  assert.deepEqual(page.diags.map(d => [d.op, d.reason]), [
    [64, 'not_armed'], [178, 'not_armed'], [64, 'not_armed'], [65, 'typing_not_armed'], [null, 'unclassified_frame'], [null, 'unclassified_frame'],
  ])
})

test('L3: an armed window passes two send-class frames and typing; one own frame passes exactly once', () => {
  const page = browser()
  page.run(LIVE_PAGE_GUARD_SCRIPT)
  const ws = new page.window.WebSocket('wss://ws-api.oneme.ru/websocket')
  assert.equal(page.window.__maxLiveArm(), true)
  ws.send(frame(OP.TYPING))
  ws.send(frame(OP.SEND_MESSAGE))
  ws.send(frame(OP.TYPING))
  ws.send(frame(OP.SEND_MESSAGE))
  ws.send(frame(OP.SEND_MESSAGE))
  assert.deepEqual(page.sent.map(opcodeOfSent), [65, 64, 65, 64])
  page.window.__maxLiveDisarm()
  ws.send(frame(OP.TYPING))
  page.sent.length = 0
  page.window.__maxLiveSendOwnFrame(() => ws.send(frame(OP.SEND_MESSAGE)))
  ws.send(frame(OP.SEND_MESSAGE))
  assert.deepEqual(page.sent.map(opcodeOfSent), [64], 'the own frame and nothing after it')
})

test('L3 composes with WS_INIT_SCRIPT: the page socket, its read-mark hook and __maxWsSendBinary all pass the guard', () => {
  const page = browser()
  page.run(LIVE_PAGE_GUARD_SCRIPT)
  page.run(WS_INIT_SCRIPT)
  const ws = new page.window.WebSocket('wss://ws-api.oneme.ru/websocket')
  assert.equal(page.window.__maxWs, ws, 'the existing hook still captures the MAX socket')
  ws.send(frame(OP.SEND_MESSAGE))
  ws.send(frame(50))
  ws.send(frame(OP.GET_HISTORY))
  const base64 = Buffer.from(new Uint8Array(frame(OP.SEND_MESSAGE))).toString('base64')
  // Results come from the page realm, so they are compared as JSON.
  assert.equal(JSON.stringify(page.window.__maxWsSendBinary(base64)), '{"ok":true}')
  assert.deepEqual(page.sent.map(opcodeOfSent), [OP.GET_HISTORY], 'unarmed sends dropped, read mark withheld, history passes')
  assert.equal(JSON.stringify(page.window.__maxLiveSendOwnFrame(() => page.window.__maxWsSendBinary(base64))), '{"ok":true}')
  assert.deepEqual(page.sent.map(opcodeOfSent), [OP.GET_HISTORY, OP.SEND_MESSAGE])
  assert.ok(page.diags.some(d => d.__diag === 'read_mark_withheld'))
})

test('OFF: the init script is WS_INIT_SCRIPT alone, unchanged', () => {
  const page = browser()
  page.run(WS_INIT_SCRIPT)
  const ws = new page.window.WebSocket('wss://ws-api.oneme.ru/websocket')
  ws.send(frame(OP.SEND_MESSAGE))
  assert.deepEqual(page.sent.map(opcodeOfSent), [OP.SEND_MESSAGE])
  assert.equal(typeof page.window.__maxLiveArm, 'undefined')
})

// ─── Transport wiring ────────────────────────────────────────────────────────

function transportWithPage(guard) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-live-guard-'))
  const transport = new TransportInterceptor({ stateDir: dir })
  const evaluations = []
  const initScripts = []
  transport._page = {
    evaluate: async (fn) => { evaluations.push(String(fn)); return { ok: true } },
    addInitScript: async script => { initScripts.push(script) },
    exposeFunction: async () => {},
    on: () => {},
  }
  transport._wsConnected = true
  transport._myUserId = 42
  if (guard) transport.setLiveAcceptanceGuard(guard)
  return { transport, evaluations, initScripts, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('transport ON: a refused send-class frame is rejected as not dispatched before the page is touched', async () => {
  const { guard } = maxGuard()
  const { transport, evaluations, cleanup } = transportWithPage(guard)
  try {
    await assert.rejects(
      transport.requestBinary(OP.SEND_MESSAGE, { chatId: BigInt(C_REAL), message: { text: 'x' } }, { timeoutMs: 20, purpose: 'media_send' }),
      error => error.liveRefused === true && error.dispatched === false && error.code === 'MAX_LIVE_FRAME_NOT_ARMED',
    )
    assert.deepEqual(evaluations, [])
  } finally { cleanup() }
})

test('transport ON: a permitted send-class frame goes through the one-shot page arm; OFF uses the old call', async () => {
  const { guard } = maxGuard()
  const on = transportWithPage(guard)
  const off = transportWithPage(offGuard())
  try {
    guard.beginSend(B, 'send_image')
    await assert.rejects(on.transport.requestBinary(OP.SEND_MESSAGE, { chatId: BigInt(B_REAL), message: { text: 'x' } }, { timeoutMs: 20 }), /timeout/)
    assert.equal(on.evaluations.length, 1)
    assert.match(on.evaluations[0], /__maxLiveSendOwnFrame/)
    await assert.rejects(on.transport.requestBinary(OP.GET_HISTORY, { chatId: BigInt(C_REAL) }, { timeoutMs: 20 }), /timeout/)
    assert.doesNotMatch(on.evaluations[1], /__maxLiveSendOwnFrame/, 'a read is not armed')
    await assert.rejects(off.transport.requestBinary(OP.SEND_MESSAGE, { chatId: BigInt(C_REAL), message: { text: 'x' } }, { timeoutMs: 20 }), /timeout/)
    assert.equal(off.evaluations[0], 'b => window.__maxWsSendBinary(b)')
  } finally { guard.endSend(); on.cleanup(); off.cleanup() }
})

test('transport: the page guard script is added before WS_INIT_SCRIPT only when the guard is on', async () => {
  const on = transportWithPage(maxGuard().guard)
  const off = transportWithPage(offGuard())
  const none = transportWithPage(null)
  try {
    await on.transport.injectHooks(on.transport._page)
    await off.transport.injectHooks(off.transport._page)
    await none.transport.injectHooks(none.transport._page)
    assert.deepEqual(on.initScripts, [LIVE_PAGE_GUARD_SCRIPT, WS_INIT_SCRIPT])
    assert.deepEqual(off.initScripts, [WS_INIT_SCRIPT])
    assert.deepEqual(none.initScripts, [WS_INIT_SCRIPT])
    assert.equal(await off.transport.armLivePageSend(), true, 'off: nothing to arm')
    assert.deepEqual(off.evaluations, [])
  } finally { on.cleanup(); off.cleanup(); none.cleanup() }
})

test('transport ON: arming fails closed when the page has no guard script', async () => {
  const { transport, cleanup } = transportWithPage(maxGuard().guard)
  transport._page.evaluate = async () => false
  try {
    assert.equal(await transport.armLivePageSend(), false)
    transport._page.evaluate = async () => { throw new Error('page closed') }
    assert.equal(await transport.armLivePageSend(), false)
  } finally { cleanup() }
})

test('transport ON: catch-up reads history only for listed chats; OFF reads every open gap', async () => {
  for (const [guard, expected] of [[maxGuard().guard, [B]], [offGuard(), [B, C]]]) {
    const { transport, cleanup } = transportWithPage(guard)
    try {
      const seen = []
      transport._gapFloors.set(B, 'd3' + '0'.repeat(15) + '1')
      transport._gapFloors.set(C, 'd3' + '0'.repeat(15) + '1')
      transport._catchUpChat = async chatId => { seen.push(chatId); return { chatId, closed: true } }
      await transport.runCatchUp({ reason: 'test' })
      assert.deepEqual(seen, expected)
    } finally { cleanup() }
  }
})

test('transport: the page reports its drops to the guard', () => {
  const { guard } = maxGuard()
  const { transport, cleanup } = transportWithPage(guard)
  try {
    transport._handleFrame(JSON.stringify({ __diag: 'live_guard_frame_dropped', op: 64, reason: 'not_armed' }))
    assert.equal(guard.statusSummary().pageFramesDropped, 1)
  } finally { cleanup() }
})

// ─── index.js: every outbound path and every emitter goes through the guard ─

const scraper = read('max-web-scraper/index.js')

function block(start, end) {
  const from = scraper.indexOf(start)
  assert.notEqual(from, -1, `missing ${start}`)
  const to = scraper.indexOf(end, from + start.length)
  assert.notEqual(to, -1, `missing end of ${start}`)
  return scraper.slice(from, to)
}

function assertOrder(text, first, second, message) {
  const a = text.indexOf(first)
  const b = text.indexOf(second)
  assert.notEqual(a, -1, `${message}: missing ${first}`)
  assert.notEqual(b, -1, `${message}: missing ${second}`)
  assert.ok(a < b, message)
}

test('the guard is built once at startup from the environment and nothing reassigns it', () => {
  assert.equal(scraper.match(/new MaxLiveAcceptanceGuard\(/g).length, 1)
  assert.match(scraper, /const liveGuard = new MaxLiveAcceptanceGuard\(\{ env: process\.env, historyImportMode: HISTORY_IMPORT_MODE \}\)/)
  assert.equal((scraper.match(/(^|[^.\w])liveGuard\s*=(?!=)/gm) || []).length, 1, 'the one assignment is the const at startup')
  assert.doesNotMatch(scraper, /YOKO_LIVE_/, 'only the guard module reads its environment')
  assert.match(scraper, /transport\.setLiveAcceptanceGuard\(liveGuard\)/)
})

test('every send handler refuses before the provider account check and runs its action under one permit', () => {
  const handlers = [
    ["app.post('/send-message'", "app.post('/send-reaction'", "withLiveSend(digits, 'send_text'"],
    ["app.post('/send-reaction'", "app.post('/delete-message'", "withLiveSend(chatId, 'reaction'"],
    ["app.post('/delete-message'", "app.post('/send-image'", "withLiveSend(chatId, 'delete'"],
    ["app.post('/send-image'", "app.post('/send-media'", "withLiveSend(chatId, 'send_image'"],
    ["app.post('/send-media'", "app.get('/contacts'", "withLiveSend(chatId, 'send_media'"],
  ]
  for (const [start, end, permit] of handlers) {
    const handler = block(start, end)
    assertOrder(handler, 'liveGuard.precheckSend(', 'requireLiveMaxProviderAccount(req, res)', `${start}: precheck first`)
    assert.ok(handler.includes(permit), `${start}: ${permit}`)
    if (start !== "app.post('/send-message'") assert.ok(handler.includes('if (e?.liveRefused) return res.status(422).json(liveRefusalBody(e))'), `${start}: refusal is terminal`)
  }
  assert.ok(block("app.post('/send-reaction'", "app.post('/delete-message'").includes("withLiveSend(chatId, 'reaction_remove'"))
  assertOrder(block("app.post('/delete-message'", "app.post('/send-image'"), 'assertLiveTarget(chatId)', 'transport.requestBinary(OP.DELETE_MESSAGE', 'delete checks its target first')
})

test('every sender checks the chat it resolved before it touches MAX', () => {
  const senders = [
    ['async function sendText(', 'function maskPhoneForLog', 'liveGuard.checkTarget(protocolChatId, route.uiRouteId)', 'runSingleMaxTextSend('],
    ['async function sendText(', 'function maskPhoneForLog', 'transport.armLivePageSend()', 'runSingleMaxTextSend('],
    ['async function sendMediaViaUi(', 'const domFallbackSeen', 'assertLiveTarget(chatId, uiRouteId)', 'page.goto(targetUrl'],
    ['async function sendMediaViaUi(', 'const domFallbackSeen', 'transport.armLivePageSend()', 'page.goto(targetUrl'],
    ['async function sendImage(', 'async function sendVideo(', 'assertLiveTarget(chatId)', 'uploadImageToMax('],
    ['async function sendVideo(', 'async function sendFile(', 'assertLiveTarget(chatId)', 'transport.requestBinary(OP.GET_UPLOAD_VIDEO_URL'],
    ['async function sendFile(', 'async function sendReactionRequest(', 'assertLiveTarget(chatId)', 'transport.requestBinary(OP.GET_UPLOAD_FILE_URL'],
    ['async function sendReactionRequest(', 'async function sendReaction(', 'assertLiveTarget(chatId)', 'transport.requestBinary(opcode'],
  ]
  for (const [start, end, check, action] of senders) assertOrder(block(start, end), check, action, `${start}: ${check} before ${action}`)
  const permit = block('async function withLiveSend(', 'function liveTextRefusal(')
  assertOrder(permit, 'liveGuard.beginSend(chatId, operation)', 'return await run()', 'the permit is taken before the action')
  assertOrder(permit, 'liveGuard.endSend()', 'await transport.disarmLivePageSend()', 'the permit ends and the page window closes')
  assert.ok(permit.includes('if (!liveGuard.enabled) return run()'), 'off: the action runs as before')
})

test('every scraper-to-CRM emitter filters on the allowlist before it posts', () => {
  assertOrder(block('function postToCrmWebhook(', '// ─── Обработка входящего'), 'liveGuard.webhookDecision(normalizedPayload)', 'mod.request(options', 'the webhook choke')
  assertOrder(block('function forwardMaxReactionWebhook(', '// ─── CRM webhook forward'), 'liveGuard.reactionAllowed(payload)', 'return fetch(url', 'reactions')
  const incoming = block('async function handleIncoming(', 'function inboundChatKey(')
  assertOrder(incoming, 'liveGuard.inboundAllowed(msg.chatId)', "if (msg.status === 'REMOVED')", 'before a deletion is forwarded')
  assertOrder(incoming, 'liveGuard.inboundAllowed(msg.chatId)', 'forwardIncomingMessage(', 'before media is downloaded or anything is forwarded')
  assert.ok(incoming.includes("inboundLedger.markPersisted(String(msg.id), msg.chatId, 'skipped:live_acceptance_not_allowlisted')"), 'a dropped id is settled, not recovered')
  assert.equal((scraper.match(/postToCrmWebhook\(/g) || []).length, 3, 'the definition, forwardToWebhook and the read-mark forward: no other path posts to the webhook')
})

test('history is locked to from_connection_time/none and /status shows the guard only when it is on', () => {
  assertOrder(block("app.post('/set-history-mode'", "app.get('/chats-from-page'"), 'liveGuard.historyModeAllowed(mode)', 'HISTORY_IMPORT_MODE = mode', 'set-history-mode')
  assertOrder(block("app.post('/import-history'", "app.post('/sync-contacts'"), 'liveGuard.importHistoryAllowed()', 'if (!isReady)', 'import-history')
  assert.ok(block("app.get('/status'", "app.get('/qr'").includes('...(liveGuard.enabled ? { liveAcceptance: liveGuard.statusSummary() } : {}),'))
})

test('the live-acceptance environment never appears in production deployment files', () => {
  const files = ['.env.production.example', 'max-web-scraper/Dockerfile', 'gravity-mvp/Dockerfile']
  const walk = dir => fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap(entry => {
    const rel = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(rel) : [rel]
  })
  for (const file of [...files, ...walk('deploy')]) {
    const text = fs.readFileSync(path.join(repoRoot, file), 'utf8')
    assert.doesNotMatch(text, /YOKO_LIVE_/, `${file} must not configure the live-acceptance guard`)
  }
})
