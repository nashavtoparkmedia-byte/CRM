import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { SegmentedFileCaptureSpool } from '../src/capture/SegmentedFileCaptureSpool.ts'

const require = createRequire(import.meta.url)
const repositoryRoot = resolve(import.meta.dirname, '../..')
const runtime = require(resolve(repositoryRoot, 'max-web-scraper/capture/LiveCaptureAdapter.js'))
const { TransportInterceptor } = require(resolve(repositoryRoot, 'max-web-scraper/transport/TransportInterceptor.js'))

function directory(name: string): string {
  const value = mkdtempSync(join(tmpdir(), `max-stage8a-runtime-${name}-`))
  temporaryRoots.push(value)
  return value
}

const temporaryRoots: string[] = []
test.after(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }) })

test('runtime factory default/invalid/wildcard modes are Noop with zero filesystem or timer side effects', () => {
  const parent = directory('disabled')
  const candidate = join(parent, 'must-not-exist')
  for (const value of [undefined, '', 'true', '*', 'account-a,!']) {
    const adapter = runtime.createLiveCaptureAdapterFromEnvironment({
      MAX_PERSONAL_ACCOUNT_ID: 'account-a',
      MAX_PERSONAL_LIVE_CAPTURE_ENABLED: value,
      MAX_PERSONAL_CAPTURE_SPOOL_PATH: candidate,
    })
    assert.equal(adapter.enabled, false)
    assert.equal(adapter.getCaptureHealth().adapterState, 'disabled')
    assert.equal(Object.hasOwn(adapter, 'timer'), false)
  }
  assert.equal(existsSync(candidate), false)
})

test('actual _handleFrame boundary captures once before legacy decode and excludes diagnostic bridge frames', () => {
  const order: string[] = []
  const observations: Array<Record<string, any>> = []
  const adapter = {
    capturePhysicalFrame(value: Record<string, any>) { order.push('capture'); observations.push(value) },
    getCaptureHealth() { return { enabled: true, adapterState: 'healthy' } },
    close() {},
  }
  const transport = new TransportInterceptor(adapter)
  transport._processDecodedFrame = () => order.push('legacy')
  transport._handleFrame(JSON.stringify({ __diag: 'ws_created', url: 'wss://synthetic.invalid' }))
  transport._handleFrame(JSON.stringify({ opcode: 128, seq: 7, payload: { kind: 'message', text: 'one' } }))
  assert.deepEqual(order, ['capture', 'legacy'])
  assert.equal(observations.length, 1)
  assert.equal(observations[0]?.metadata.opcode, 128)
  assert.equal(observations[0]?.metadata.sourceOrigin, 'live')
  assert.equal(observations[0]?.metadata.socketGeneration, 'socket-1')

  transport._handleFrame(JSON.stringify({ __diag: 'ws_created', url: 'wss://synthetic.invalid/reconnect' }))
  transport._handleFrame(JSON.stringify({ opcode: 49, seq: 8, payload: { kind: 'message', text: 'history' } }))
  assert.equal(observations.length, 2)
  assert.equal(observations[1]?.metadata.sourceOrigin, 'history')
  assert.equal(observations[1]?.metadata.socketGeneration, 'socket-2')
})

test('unknown, malformed, and binary frames are each captured once while legacy path remains fail-open', () => {
  let captures = 0
  let legacy = 0
  const adapter = {
    capturePhysicalFrame() { captures += 1; if (captures === 1) throw new Error('synthetic capture failure') },
    getCaptureHealth() { return { enabled: true, adapterState: 'critical' } },
    close() {},
  }
  const transport = new TransportInterceptor(adapter)
  transport._processDecodedFrame = () => { legacy += 1 }
  transport._handleFrame(JSON.stringify({ opcode: 999, payload: { future: true } }))
  transport._handleFrame('{malformed')
  transport._handleFrame(`b64:${Buffer.from([0x01, 0x02, 0x03]).toString('base64')}`)
  assert.equal(captures, 3)
  assert.equal(legacy, 1)
  assert.equal(transport.getCaptureHealth().hookFailureCount, 1)
})

test('runtime adapter writes gateway-compatible durable records for 1000 events and 100 identical frames', () => {
  const spoolPath = directory('load')
  const adapter = new runtime.LiveCaptureAdapter({ accountId: 'account-a', spoolPath, maxSpoolBytes: 64 * 1024 * 1024 })
  const transport = new TransportInterceptor(adapter)
  transport._processDecodedFrame = () => {}
  transport._handleFrame(JSON.stringify({ __diag: 'ws_created', url: 'wss://synthetic.invalid' }))
  for (let index = 0; index < 1000; index += 1) {
    transport._handleFrame(JSON.stringify({
      opcode: 128,
      seq: index,
      payload: { kind: 'message', direction: 'inbound', providerMessageId: `provider-${index}`, text: `synthetic-${index}` },
    }))
  }
  const identical = JSON.stringify({ opcode: 128, seq: 1001, payload: { kind: 'message', text: 'identical' } })
  for (let index = 0; index < 100; index += 1) transport._handleFrame(identical)
  const spool = new SegmentedFileCaptureSpool({ directory: spoolPath, maxTotalBytes: 64 * 1024 * 1024 })
  const records = spool.readPending(2000)
  assert.equal(records.length, 1100)
  assert.equal(new Set(records.map(record => record.envelope.captureEnvelopeId)).size, 1100)
  const duplicateRecords = records.slice(-100)
  assert.equal(new Set(duplicateRecords.map(record => record.envelope.payloadSha256)).size, 1)
  assert.equal(new Set(duplicateRecords.map(record => record.envelope.captureEnvelopeId)).size, 100)
  assert.equal(readdirSync(spoolPath).filter(name => name.endsWith('.jsonl')).length >= 1, true)
})

test('runtime sanitizer removes credentials before the durable append', () => {
  const spoolPath = directory('sanitizer')
  const adapter = new runtime.LiveCaptureAdapter({ accountId: 'account-a', spoolPath })
  adapter.capturePhysicalFrame({
    raw: JSON.stringify({ opcode: 128, payload: {
      kind: 'message', Authorization: 'Bearer runtime-forbidden', Cookie: 'session=runtime-forbidden',
      signedUrl: 'https://example.invalid/file?token=runtime-forbidden',
    } }),
    metadata: { opcode: 128, sourceOrigin: 'live', socketGeneration: 'socket-1' },
  })
  const contents = readdirSync(spoolPath).filter(name => name.endsWith('.jsonl'))
    .map(name => readFileSync(join(spoolPath, name), 'utf8')).join('')
  assert.doesNotMatch(contents, /runtime-forbidden/)
  assert.match(contents, /REDACTED/)
})

test('enabled runtime quarantines a corrupt tail and retains its valid durable prefix', () => {
  const spoolPath = directory('corrupt-recovery')
  let adapter = new runtime.LiveCaptureAdapter({ accountId: 'account-a', spoolPath })
  adapter.capturePhysicalFrame({
    raw: JSON.stringify({ opcode: 128, payload: { kind: 'message', text: 'safe' } }),
    metadata: { opcode: 128, sourceOrigin: 'live', socketGeneration: 'socket-1' },
  })
  const segment = readdirSync(spoolPath).find(name => name.endsWith('.jsonl'))
  assert.ok(segment)
  appendFileSync(join(spoolPath, segment), '{partial', 'utf8')
  adapter = new runtime.LiveCaptureAdapter({ accountId: 'account-a', spoolPath })
  const health = adapter.getCaptureHealth()
  assert.equal(health.adapterState, 'critical')
  assert.equal(health.spoolPendingCount, 1)
  assert.equal(health.quarantinedCount, 1)
  assert.equal(readdirSync(join(spoolPath, 'quarantine')).length, 1)
})

test('enabled runtime startup failure remains visible as critical instead of silently disabling capture', () => {
  const parent = directory('critical-startup')
  const notDirectory = join(parent, 'not-a-directory')
  writeFileSync(notDirectory, 'synthetic', { mode: 0o600 })
  const adapter = runtime.createLiveCaptureAdapterFromEnvironment({
    MAX_PERSONAL_ACCOUNT_ID: 'account-a',
    MAX_PERSONAL_LIVE_CAPTURE_ENABLED: 'account-a',
    MAX_PERSONAL_CAPTURE_SPOOL_PATH: notDirectory,
  })
  assert.equal(adapter.enabled, true)
  assert.equal(adapter.getCaptureHealth().adapterState, 'critical')
  adapter.capturePhysicalFrame({ raw: '{}', metadata: {} })
  assert.equal(adapter.getCaptureHealth().lostBeforeSpoolCount, 1)
})

test('SIGKILL of disposable capture process preserves 100 fsync-durable envelopes for restart', async () => {
  const spoolPath = directory('crash')
  const adapterPath = resolve(repositoryRoot, 'max-web-scraper/capture/LiveCaptureAdapter.js')
  const script = `
    const { LiveCaptureAdapter } = require(process.argv[1]);
    const adapter = new LiveCaptureAdapter({ accountId: 'account-a', spoolPath: process.argv[2] });
    for (let i = 0; i < 100; i++) adapter.capturePhysicalFrame({
      raw: JSON.stringify({ opcode: 128, payload: { kind: 'message', text: 'crash-' + i } }),
      metadata: { opcode: 128, sourceOrigin: 'live', socketGeneration: 'socket-1', transportSequence: String(i) },
    });
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, ['-e', script, adapterPath, spoolPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('disposable capture child did not become ready')), 10_000)
    child.stdout.once('data', data => {
      clearTimeout(timer)
      assert.match(String(data), /READY/)
      resolveReady()
    })
    child.once('error', reject)
  })
  child.kill('SIGKILL')
  await new Promise<void>(resolveExit => child.once('exit', () => resolveExit()))
  const recovered = new SegmentedFileCaptureSpool({ directory: spoolPath })
  assert.equal(recovered.readPending(100).length, 100)
  assert.equal(recovered.getCaptureHealth().lostBeforeSpoolCount, 0)
})
