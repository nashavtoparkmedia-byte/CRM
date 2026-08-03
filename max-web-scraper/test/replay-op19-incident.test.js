'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const test = require('node:test')

const {
  INCIDENT_ACCOUNT_ID,
  INCIDENT_BINDING,
  INCIDENT_ROWS,
  MAX_STDIN_BYTES,
  buildWebhookPayload,
  canonicalJson,
  canonicalPayloadSha256,
  isInternalHostname,
  parseCliArguments,
  parseRowsJson,
  prepareReplayItems,
  readStdinBounded,
  requireInternalWebhookUrl,
  runReplay,
} = require('../scripts/replay-op19-incident')
const { LiveCaptureAdapter } = require('../capture/LiveCaptureAdapter')
const { bindOpcode19ReconnectMessage } = require('../transport/Opcode19ReconnectDecoder')

const BASE_TIME = Date.parse('2026-08-03T00:00:00.000Z')

function rawRow(sequence) {
  const expected = INCIDENT_ROWS[String(sequence)]
  return {
    journalSequence: Number(sequence),
    observationId: expected.observationId,
    accountId: INCIDENT_ACCOUNT_ID,
    opcode: 19,
    replayAvailability: 'available',
    payloadSha256: expected.payloadSha256,
    sanitizedPayload: { syntheticIncidentSequence: String(sequence) },
  }
}

function dependencies(overrides = {}) {
  return {
    canonicalPayloadSha256(_payload, row) {
      return row.payloadSha256
    },
    decodeOpcode19ReconnectPayload(payload) {
      const expected = INCIDENT_ROWS[payload.syntheticIncidentSequence]
      if (!expected) return { ok: false, reason: 'synthetic_not_allowlisted' }
      return {
        ok: true,
        candidate: {
          providerMessageId: expected.providerMessageId,
          providerTimestampMs: BASE_TIME + Number(expected.journalSequence),
          text: expected.text,
        },
      }
    },
    bindOpcode19ReconnectMessage(decoded) {
      return {
        ok: true,
        candidate: decoded.candidate,
        binding: { ...INCIDENT_BINDING },
        messageEnvelope: {},
      }
    },
    ...overrides,
  }
}

function incidentRowsReversed() {
  return [rawRow(69360), rawRow(68978)]
}

test('canonical JSON is deterministic and raw input is a bounded JSON array', async () => {
  assert.equal(canonicalJson({ z: 1, a: [true, { y: 2, x: null }] }), '{"a":[true,{"x":null,"y":2}],"z":1}')
  assert.deepEqual(parseRowsJson('[{"journalSequence":68978}]'), [{ journalSequence: 68978 }])
  assert.throws(() => parseRowsJson('{"rows":[]}'), error => error.code === 'RAW_ROWS_NOT_ARRAY')
  assert.throws(() => parseRowsJson(''), error => error.code === 'STDIN_EMPTY')
  assert.throws(() => parseRowsJson('['), error => error.code === 'STDIN_JSON_INVALID')

  const bounded = await readStdinBounded(Readable.from(['[', ']', ' \n']))
  assert.equal(bounded, '[] \n')
  await assert.rejects(
    readStdinBounded(Readable.from([Buffer.alloc(MAX_STDIN_BYTES + 1, 0x20)])),
    error => error.code === 'STDIN_OVERSIZED',
  )
})

test('payload hash verification matches the live capture sanitized-journal contract', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'op19-replay-hash-'))
  try {
    const adapter = new LiveCaptureAdapter({
      accountId: INCIDENT_ACCOUNT_ID,
      spoolPath: directory,
    })
    adapter.capturePhysicalFrame({
      raw: JSON.stringify({
        opcode: 19,
        payload: [0, { z: 'безопасно', a: [true, null, 902454841098] }, 'd3019fc8d4774a04bc'],
      }),
      metadata: { opcode: 19, sourceOrigin: 'live' },
    })
    const [record] = adapter.spool.readPending(1)
    assert.ok(record)
    assert.equal(
      canonicalPayloadSha256(record.envelope.sanitizedPayload),
      record.envelope.payloadSha256,
    )

    const gatewaySanitizer = fs.readFileSync(
      path.join(__dirname, '..', '..', 'max-personal-gateway', 'src', 'journal', 'sanitizer.ts'),
      'utf8',
    )
    assert.match(gatewaySanitizer, /Object\.keys\(value\)\.sort\(\)/)
    assert.match(gatewaySanitizer, /createHash\('sha256'\)\.update\(canonicalPayload\)/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('CLI defaults to dry-run and accepts only the two explicit modes', () => {
  assert.deepEqual(parseCliArguments([]), { apply: false })
  assert.deepEqual(parseCliArguments(['--dry-run']), { apply: false })
  assert.deepEqual(parseCliArguments(['--apply']), { apply: true })
  assert.throws(() => parseCliArguments(['--apply', '--dry-run']), error => error.code === 'CLI_ARGUMENTS_INVALID')
  assert.throws(() => parseCliArguments(['--force']), error => error.code === 'CLI_ARGUMENTS_INVALID')
})

test('dry-run requires the exact two-row allowlist and orders by provider timestamp', async () => {
  let posts = 0
  const result = await runReplay({
    rows: incidentRowsReversed(),
    dependencies: dependencies(),
    postJson: async () => { posts += 1 },
  })

  assert.equal(result.success, true)
  assert.equal(result.mode, 'dry-run')
  assert.equal(result.readyCount, 2)
  assert.equal(result.providerActions, 0)
  assert.equal(result.databaseDirectWrites, 0)
  assert.equal(result.rawJournalMutations, 0)
  assert.equal(posts, 0)
  assert.deepEqual(result.items.map(item => item.journalSequence), ['68978', '69360'])
  assert.deepEqual(result.items.map(item => item.providerMessageId), [
    'd3019fc8d4774a04bc',
    'd3019fc8d8ab3a4130',
  ])
})

test('the shared binder proves the exact account owner, full sender, protocol chat, and web route', () => {
  const exactDependencies = dependencies({
    decodeOpcode19ReconnectPayload(payload) {
      const expected = INCIDENT_ROWS[payload.syntheticIncidentSequence]
      return {
        ok: true,
        candidate: {
          providerMessageId: expected.providerMessageId,
          providerTimestampMs: BASE_TIME + Number(expected.journalSequence),
          text: expected.text,
          senderProviderUserId: '902264026154',
          protocolChatId: '902454841098',
          senderLow32: '320893994',
          webRouteLow32: '511708938',
        },
      }
    },
    bindOpcode19ReconnectMessage,
  })

  const items = prepareReplayItems(incidentRowsReversed(), exactDependencies)
  assert.equal(items.length, 2)
  assert.ok(items.every(item => item.binding.accountId === INCIDENT_ACCOUNT_ID))
  assert.ok(items.every(item => item.binding.ownerProviderUserId === '902171753248'))
  assert.ok(items.every(item => item.binding.senderProviderUserId === '902264026154'))
  assert.ok(items.every(item => item.binding.protocolChatId === '902454841098'))
  assert.ok(items.every(item => item.binding.webRouteId === '511708938'))
})

test('raw metadata, content hash, decoded identity, and route binding all fail closed', async t => {
  await t.test('missing or extra rows', () => {
    assert.throws(
      () => prepareReplayItems([rawRow(68978)], dependencies()),
      error => error.code === 'RAW_ROW_COUNT_MISMATCH',
    )
    assert.throws(
      () => prepareReplayItems([rawRow(68978), rawRow(69360), rawRow(68978)], dependencies()),
      error => error.code === 'RAW_ROW_COUNT_MISMATCH',
    )
  })
  const cases = [
    ['unexpected sequence', rows => { rows[0].journalSequence = 1 }, 'RAW_ROW_NOT_ALLOWLISTED'],
    ['observation mismatch', rows => { rows[0].observationId = 'wrong' }, 'OBSERVATION_ID_MISMATCH'],
    ['account mismatch', rows => { rows[0].accountId = 'max-personal-other' }, 'ACCOUNT_ID_MISMATCH'],
    ['opcode mismatch', rows => { rows[0].opcode = 128 }, 'OPCODE_MISMATCH'],
    ['unavailable replay', rows => { rows[0].replayAvailability = 'quarantined' }, 'REPLAY_NOT_AVAILABLE'],
    ['SHA metadata mismatch', rows => { rows[0].payloadSha256 = '0'.repeat(64) }, 'PAYLOAD_SHA_METADATA_MISMATCH'],
    ['duplicate row', rows => { rows[1] = { ...rows[0] } }, 'RAW_ROW_DUPLICATE'],
  ]
  for (const [name, mutate, code] of cases) {
    await t.test(name, () => {
      const rows = incidentRowsReversed()
      mutate(rows)
      assert.throws(() => prepareReplayItems(rows, dependencies()), error => error.code === code)
    })
  }

  await t.test('content hash mismatch', () => {
    assert.throws(
      () => prepareReplayItems(incidentRowsReversed(), dependencies({ canonicalPayloadSha256: () => 'f'.repeat(64) })),
      error => error.code === 'PAYLOAD_SHA_CONTENT_MISMATCH',
    )
  })
  await t.test('decoded provider identity mismatch', () => {
    assert.throws(
      () => prepareReplayItems(incidentRowsReversed(), dependencies({
        decodeOpcode19ReconnectPayload: () => ({
          ok: true,
          candidate: { providerMessageId: 'd30100000000000000', providerTimestampMs: BASE_TIME, text: 'у' },
        }),
      })),
      error => error.code === 'INCIDENT_MESSAGE_MISMATCH',
    )
  })
  await t.test('ambiguous route binding', () => {
    assert.throws(
      () => prepareReplayItems(incidentRowsReversed(), dependencies({
        bindOpcode19ReconnectMessage: () => ({ ok: false, reason: 'binding_match_count_mismatch' }),
      })),
      error => error.code === 'INCIDENT_BINDING_REJECTED',
    )
  })
})

test('normal webhook payload retains exact provider, account, and route identities', () => {
  const [item] = prepareReplayItems([rawRow(68978), rawRow(69360)], dependencies())
  const payload = buildWebhookPayload(item)

  assert.deepEqual(payload, {
    externalId: 'd3019fc8d4774a04bc',
    chatId: '902454841098',
    senderId: '902264026154',
    phone: null,
    text: 'ывапро',
    timestamp: new Date(BASE_TIME + 68978).toISOString(),
    messageType: 'text',
    attachments: [],
    isOutgoing: false,
    replyToExternalId: null,
    source: 'raw_journal_replay',
    rawChatId: '902454841098',
    providerAccountId: 'max-personal-81d98d8cc9fc95c1f1c0461f',
    protocolChatId: '902454841098',
    uiRouteId: '511708938',
    providerUserId: '902264026154',
  })
})

test('apply requires the explicit authorization and exact internal plural webhook', async () => {
  const rows = incidentRowsReversed()
  let posts = 0
  const postJson = async () => {
    posts += 1
    return { status: 200, json: { success: true, messageId: 'm', chatInternalId: 'c' } }
  }

  await assert.rejects(
    runReplay({ rows, apply: true, env: {}, dependencies: dependencies(), postJson }),
    error => error.code === 'REPLAY_NOT_AUTHORIZED',
  )
  await assert.rejects(
    runReplay({
      rows,
      apply: true,
      env: { PERSONAL_MAX_OPCODE19_REPLAY_AUTHORIZED: 'YES' },
      dependencies: dependencies(),
      postJson,
    }),
    error => error.code === 'CRM_WEBHOOK_URL_REQUIRED',
  )
  assert.equal(posts, 0)

  const invalidUrls = [
    'https://crm.example.com/api/webhooks/max',
    'http://crm-app:3002/api/webhook/max',
    'http://user:secret@crm-app:3002/api/webhooks/max',
    'http://crm-app:3002/api/webhooks/max?token=no',
  ]
  for (const CRM_WEBHOOK_URL of invalidUrls) {
    assert.throws(
      () => requireInternalWebhookUrl({ CRM_WEBHOOK_URL }),
      error => error.code === 'CRM_WEBHOOK_URL_NOT_INTERNAL',
    )
  }
  assert.equal(
    requireInternalWebhookUrl({ CRM_WEBHOOK_URL: 'http://gravity-mvp:3002/api/webhooks/max' }),
    'http://gravity-mvp:3002/api/webhooks/max',
  )
  assert.equal(isInternalHostname('10.2.3.4'), true)
  assert.equal(isInternalHostname('172.31.5.4'), true)
  assert.equal(isInternalHostname('8.8.8.8'), false)
})

test('apply posts serially in provider time order and accepts durable deduplication', async () => {
  const calls = []
  let inFlight = 0
  let maximumInFlight = 0
  const result = await runReplay({
    rows: incidentRowsReversed(),
    apply: true,
    env: {
      PERSONAL_MAX_OPCODE19_REPLAY_AUTHORIZED: 'YES',
      CRM_WEBHOOK_URL: 'http://gravity-mvp:3002/api/webhooks/max',
      MAX_PERSONAL_CRM_WEBHOOK_TIMEOUT_MS: '12000',
    },
    dependencies: dependencies(),
    postJson: async (url, payload, options) => {
      inFlight += 1
      maximumInFlight = Math.max(maximumInFlight, inFlight)
      calls.push({ url, payload, options })
      await new Promise(resolve => setImmediate(resolve))
      inFlight -= 1
      return {
        status: 200,
        json: {
          success: true,
          messageId: `crm-${payload.externalId}`,
          chatInternalId: 'chat-internal-contact-a',
          deduped: payload.externalId.endsWith('4130'),
        },
      }
    },
  })

  assert.equal(result.success, true)
  assert.equal(result.mode, 'apply')
  assert.equal(result.acknowledgedCount, 2)
  assert.equal(result.providerActions, 0)
  assert.equal(maximumInFlight, 1)
  assert.deepEqual(calls.map(call => call.payload.externalId), [
    'd3019fc8d4774a04bc',
    'd3019fc8d8ab3a4130',
  ])
  assert.ok(calls[0].payload.timestamp < calls[1].payload.timestamp)
  assert.ok(calls.every(call => call.url === 'http://gravity-mvp:3002/api/webhooks/max'))
  assert.ok(calls.every(call => call.options.timeoutMs === '12000'))
  assert.deepEqual(result.items.map(item => item.deduped), [false, true])
})

test('a complete rerun is safe when the CRM provider-ID fence reports both rows deduped', async () => {
  let invocation = 0
  const postJson = async (_url, payload) => {
    invocation += 1
    return {
      status: 200,
      json: {
        success: true,
        messageId: `stable-crm-${payload.externalId}`,
        chatInternalId: 'stable-chat-contact-a',
        deduped: invocation > 2,
      },
    }
  }
  const options = {
    rows: incidentRowsReversed(),
    apply: true,
    env: {
      PERSONAL_MAX_OPCODE19_REPLAY_AUTHORIZED: 'YES',
      CRM_WEBHOOK_URL: 'http://gravity-mvp:3002/api/webhooks/max',
    },
    dependencies: dependencies(),
    postJson,
  }

  const first = await runReplay(options)
  const rerun = await runReplay(options)

  assert.equal(invocation, 4)
  assert.deepEqual(first.items.map(item => item.deduped), [false, false])
  assert.deepEqual(rerun.items.map(item => item.deduped), [true, true])
  assert.deepEqual(
    rerun.items.map(item => item.messageId),
    first.items.map(item => item.messageId),
  )
})

test('skipped or non-durable webhook response stops the serial replay', async t => {
  const responses = [
    { status: 200, json: { success: true, skipped: 'empty_text' }, skipped: 'empty_text' },
    { status: 503, json: { success: false } },
    { status: 200, json: { success: true, messageId: 'm-without-chat' } },
  ]
  for (const response of responses) {
    await t.test(`rejects ${JSON.stringify(response)}`, async () => {
      let posts = 0
      await assert.rejects(
        runReplay({
          rows: incidentRowsReversed(),
          apply: true,
          env: {
            PERSONAL_MAX_OPCODE19_REPLAY_AUTHORIZED: 'YES',
            CRM_WEBHOOK_URL: 'http://gravity-mvp:3002/api/webhooks/max',
          },
          dependencies: dependencies(),
          postJson: async () => {
            posts += 1
            return response
          },
        }),
        error => ['CRM_WEBHOOK_SKIPPED', 'CRM_WEBHOOK_NOT_DURABLE'].includes(error.code),
      )
      assert.equal(posts, 1)
    })
  }
})

test('replay source is side-effect scoped to the CRM webhook and guards require.main', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'replay-op19-incident.js'), 'utf8')
  assert.match(source, /require\.main === module/)
  assert.match(source, /\.\.\/transport\/Opcode19ReconnectDecoder/)
  assert.match(source, /\.\.\/inbound\/CrmWebhookDelivery/)
  assert.doesNotMatch(source, /@prisma|PrismaClient|\.sendFrame\(|sendTextViaUi|page\.goto|docker|child_process/)
})
