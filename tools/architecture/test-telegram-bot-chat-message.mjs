#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  evaluateTelegramBotChatMessageBoundary,
  loadTelegramBotChatMessageBoundarySources,
} from './check-telegram-bot-chat-message-boundary.mjs'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-bot-chat-'))
const sources = [
  'gravity-mvp/src/contracts/telegram-channel/v1/bot-chat-message-commands.ts',
  'gravity-mvp/src/contracts/telegram-channel/v1/index.ts',
  'gravity-mvp/src/modules/telegram-channel/public/v1/bot-chat-message-handler.ts',
].map((value) => path.join(root, value))
const compile = spawnSync(process.execPath, [
  path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc'),
  '--target', 'ES2022',
  '--module', 'commonjs',
  '--moduleResolution', 'node',
  '--strict',
  '--skipLibCheck',
  '--rootDir', path.join(root, 'gravity-mvp/src'),
  '--outDir', out,
  ...sources,
], { encoding: 'utf8' })

if (compile.status !== 0) {
  process.stderr.write(compile.stdout + compile.stderr)
  process.exit(1)
}

const require = createRequire(import.meta.url)
const contracts = require(path.join(out, 'contracts/telegram-channel/v1/index.js'))
const {
  createDismissBotLinkRequestHandlerV1,
  createRecordPendingBotLinkRequestHandlerV1,
} = require(path.join(out, 'modules/telegram-channel/public/v1/bot-chat-message-handler.js'))
const checks = []
const check = (name, probe) => {
  probe()
  checks.push(name)
}
const checkAsync = async (name, probe) => {
  await probe()
  checks.push(name)
}

const expectBoundaryFailure = (name, sourceMutation, expectedCheck) => {
  const liveSources = loadTelegramBotChatMessageBoundarySources(root)
  const result = evaluateTelegramBotChatMessageBoundary(sourceMutation(liveSources))
  assert.equal(result.status, 'FAIL')
  assert(result.failures.some((failure) => failure.check === expectedCheck), JSON.stringify(result.failures))
  checks.push(name)
}

try {
  const dismiss = {
    contract: contracts.DISMISS_BOT_LINK_REQUEST_COMMAND_V1,
    requestId: 'r1',
  }
  const record = {
    contract: contracts.RECORD_PENDING_BOT_LINK_REQUEST_COMMAND_V1,
    telegramId: '123',
    text: '[Запрос привязки] Телефон: +7999, @user',
  }

  check('identifiers explicit', () => {
    assert.equal(
      contracts.DISMISS_BOT_LINK_REQUEST_COMMAND_V1,
      'telegram_channel.DismissBotLinkRequestCommand.v1',
    )
    assert.equal(
      contracts.RECORD_PENDING_BOT_LINK_REQUEST_COMMAND_V1,
      'telegram_channel.RecordPendingBotLinkRequestCommand.v1',
    )
  })
  check('dismiss parses', () => {
    assert.deepEqual(contracts.parseDismissBotLinkRequestCommandV1(dismiss), dismiss)
  })
  check('record parses', () => {
    assert.deepEqual(contracts.parseRecordPendingBotLinkRequestCommandV1(record), record)
  })
  check('v2 rejected', () => {
    assert.throws(
      () => contracts.parseDismissBotLinkRequestCommandV1({
        ...dismiss,
        contract: 'telegram_channel.DismissBotLinkRequestCommand.v2',
      }),
      (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    )
    assert.throws(
      () => contracts.parseRecordPendingBotLinkRequestCommandV1({
        ...record,
        contract: 'telegram_channel.RecordPendingBotLinkRequestCommand.v2',
      }),
      (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    )
  })
  check('unknown fields rejected', () => {
    assert.throws(() => contracts.parseDismissBotLinkRequestCommandV1({ ...dismiss, force: true }))
    assert.throws(() => contracts.parseRecordPendingBotLinkRequestCommandV1({ ...record, direction: 'INCOMING' }))
  })
  check('invalid types rejected', () => {
    assert.throws(() => contracts.parseDismissBotLinkRequestCommandV1({ ...dismiss, requestId: 1 }))
    assert.throws(() => contracts.parseRecordPendingBotLinkRequestCommandV1({ ...record, telegramId: 123 }))
    assert.throws(() => contracts.parseRecordPendingBotLinkRequestCommandV1({ ...record, text: null }))
  })

  const calls = []
  const port = {
    async dismiss(id) { calls.push(['dismiss', id]) },
    async recordPending(value) { calls.push(['record', value]) },
  }
  const dismissHandler = createDismissBotLinkRequestHandlerV1(port)
  const recordHandler = createRecordPendingBotLinkRequestHandlerV1(port)
  const dismissResult = await dismissHandler(dismiss)
  const recordResult = await recordHandler(record)

  check('exact mappings', () => {
    assert.deepEqual(calls, [
      ['dismiss', 'r1'],
      ['record', { telegramId: '123', text: record.text }],
    ])
  })
  check('results explicit', () => {
    assert.deepEqual(dismissResult, {
      contract: contracts.DISMISS_BOT_LINK_REQUEST_RESULT_V1,
      deleted: true,
    })
    assert.deepEqual(recordResult, {
      contract: contracts.RECORD_PENDING_BOT_LINK_REQUEST_RESULT_V1,
      recorded: true,
    })
  })
  await checkAsync('invalid never persists', async () => {
    const before = calls.length
    await assert.rejects(dismissHandler({ ...dismiss, requestId: 1 }))
    await assert.rejects(recordHandler({ ...record, text: null }))
    assert.equal(calls.length, before)
  })
  await checkAsync('owner failures visible', async () => {
    const failing = {
      async dismiss() { throw new Error('dismiss down') },
      async recordPending() { throw new Error('record down') },
    }
    await assert.rejects(createDismissBotLinkRequestHandlerV1(failing)(dismiss), /dismiss down/u)
    await assert.rejects(createRecordPendingBotLinkRequestHandlerV1(failing)(record), /record down/u)
  })

  check('current boundary sources pass', () => {
    const result = evaluateTelegramBotChatMessageBoundary(loadTelegramBotChatMessageBoundarySources(root))
    assert.equal(result.status, 'PASS', JSON.stringify(result.failures))
  })
  expectBoundaryFailure('delete mapping fails closed', (liveSources) => ({
    ...liveSources,
    adapter: liveSources.adapter.replace(
      'tx.botChatMessage.deleteMany({ where: { id: requestId } })',
      "tx.botChatMessage.deleteMany({ where: { id: 'wrong-request' } })",
    ),
  }), 'dismiss id mapping retained')
  expectBoundaryFailure('record mapping fails closed', (liveSources) => ({
    ...liveSources,
    adapter: liveSources.adapter.replace(
      'const telegramId = BigInt(input.telegramId)',
      'const telegramId = String(input.telegramId)',
    ),
  }), 'record mapping retained')
  expectBoundaryFailure('record dedupe fails closed', (liveSources) => ({
    ...liveSources,
    adapter: liveSources.adapter.replace(
      'data: { text: input.text }',
      "data: { text: 'stale' }",
    ),
  }), 'record dedupe retained')
  expectBoundaryFailure('consumer foreign write fails closed', (liveSources) => ({
    ...liveSources,
    users: `${liveSources.users}\nvoid prisma.botChatMessage.deleteMany({})\n`,
  }), 'writes isolated')
} finally {
  rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
