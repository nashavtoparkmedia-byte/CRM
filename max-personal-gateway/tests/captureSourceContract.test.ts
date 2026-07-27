import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const source = (relative: string): string => readFileSync(resolve(repositoryRoot, relative), 'utf8')
const allowlist = JSON.parse(source('max-personal-gateway/tests/support/stage8a-runtime-allowlist.json')) as {
  baseCommit: string
  runtimeFiles: string[]
  authoritativeCaptureBoundary: string
}

test('machine-readable runtime allowlist exactly matches Stage 8A runtime delta', () => {
  const changed = execFileSync('git', ['diff', '--name-only', allowlist.baseCommit, '--', 'max-web-scraper'], {
    cwd: repositoryRoot, encoding: 'utf8',
  }).trim().split('\n').filter(Boolean)
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'max-web-scraper'], {
    cwd: repositoryRoot, encoding: 'utf8',
  }).trim().split('\n').filter(value => value && !value.endsWith('/node_modules') && !value.endsWith('node_modules'))
  changed.push(...untracked)
  changed.sort()
  assert.deepEqual(changed, [...allowlist.runtimeFiles].sort())
  assert.equal(allowlist.authoritativeCaptureBoundary, 'TransportInterceptor._handleFrame')
})

test('Stage 8A adds no second browser owner, persistent context, incoming listener, provider send, DOM navigation, or CRM projection', () => {
  const patch = execFileSync('git', ['diff', '--unified=0', allowlist.baseCommit, '--', ...allowlist.runtimeFiles], {
    cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  })
  const additions = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n')
  assert.doesNotMatch(additions, /launchPersistentContext|chromium\.launch|newCDPSession|webSocketFrameReceived|framereceived/)
  assert.doesNotMatch(additions, /sendFrame|send-message|SerializedOutboundQueue|page\.goto|CRM_WEBHOOK_URL|MessageService/)
  assert.equal((source('max-web-scraper/index.js').match(/launchPersistentContext\(/g) ?? []).length, 1)
  assert.equal((source('max-web-scraper/transport/TransportInterceptor.js').match(/exposeFunction\('__maxWsReceive'/g) ?? []).length, 1)
  assert.equal((source('max-web-scraper/transport/TransportInterceptor.js').match(/newCDPSession\(/g) ?? []).length, 1)
})

test('protected legacy synchronization, parser, sender, and projection paths have no Stage 8A delta', () => {
  const protectedPaths = [
    'max-web-scraper/sync/MessageSync.js',
    'max-web-scraper/sync/InitialHistorySync.js',
    'max-web-scraper/lib/SerializedOutboundQueue.js',
    'max-personal-gateway/src/inbound/parserRegistry.ts',
    'max-personal-gateway/src/outbound',
    'gravity-mvp/src',
  ]
  execFileSync('git', ['diff', '--quiet', allowlist.baseCommit, '--', ...protectedPaths], { cwd: repositoryRoot })
})

test('capture module has no browser, Redis, sender, provider action, DOM, or CRM projection dependency', () => {
  const files = [
    'max-personal-gateway/src/capture/CaptureDrainWorker.ts',
    'max-personal-gateway/src/capture/CaptureEnvelopeFactory.ts',
    'max-personal-gateway/src/capture/PrismaRawCaptureIngress.ts',
    'max-personal-gateway/src/capture/SegmentedFileCaptureSpool.ts',
    'max-personal-gateway/src/capture/types.ts',
    'max-web-scraper/capture/LiveCaptureAdapter.js',
  ].map(source).join('\n')
  assert.doesNotMatch(files, /playwright|puppeteer|chromium|ioredis|bullmq|redis|sendFrame|send-message|page\.goto|MessageService/)
  const flag = source('max-personal-gateway/src/capture/featureFlag.ts')
  assert.doesNotMatch(flag, /\|\|\s*true|default.*true/i)
})

test('migration uniqueness is partial, account-scoped, and never content/provider based', () => {
  const migration = source('gravity-mvp/prisma/migrations/20260727154647_add_max_capture_ingress/migration.sql')
  assert.match(migration, /UNIQUE INDEX "MaxRawTransportEvent_accountId_captureEnvelopeId_key"/)
  assert.match(migration, /\("accountId", "captureEnvelopeId"\)/)
  assert.match(migration, /WHERE "captureEnvelopeId" IS NOT NULL/)
  assert.doesNotMatch(migration, /UNIQUE INDEX[^\n]*(payloadSha256|providerEventId|frameId|transportSequence|observedAt)/i)
})
