#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-manual-driver-telegram-delivery-'))
const paths = {
  contract: 'gravity-mvp/src/contracts/telegram-channel/v1/manual-driver-telegram-link-commands.ts',
  contractIndex: 'gravity-mvp/src/contracts/telegram-channel/v1/index.ts',
  handler: 'gravity-mvp/src/modules/telegram-channel/public/v1/manual-driver-telegram-link-handler.ts',
  notificationHandler: 'gravity-mvp/src/modules/telegram-channel/public/v1/manual-driver-telegram-link-notification-handler.ts',
  adapter: 'gravity-mvp/src/modules/telegram-channel/public/v1/legacy-prisma-manual-driver-telegram-link-adapter.ts',
  notificationAdapter: 'gravity-mvp/src/modules/telegram-channel/public/v1/legacy-bot-api-manual-driver-telegram-link-notification-adapter.ts',
  publicIndex: 'gravity-mvp/src/modules/telegram-channel/public/v1/index.ts',
  orchestrator: 'gravity-mvp/src/modules/platform-shell/internal/driver-telegram-link-orchestrator.ts',
  route: 'gravity-mvp/src/app/api/platform/drivers/[id]/telegram-link/route.ts',
  client: 'gravity-mvp/src/app/drivers/[id]/TelegramLinkClient.tsx',
  legacyAction: 'gravity-mvp/src/app/drivers/[id]/actions.ts',
  page: 'gravity-mvp/src/app/drivers/[id]/page.tsx',
}
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const compiled = spawnSync(process.execPath, [
  path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc'),
  '--target', 'ES2022',
  '--module', 'commonjs',
  '--moduleResolution', 'node',
  '--strict',
  '--skipLibCheck',
  '--rootDir', path.join(root, 'gravity-mvp/src'),
  '--outDir', out,
  ...[
    paths.contract,
    paths.contractIndex,
    paths.handler,
    paths.notificationHandler,
  ].map((value) => path.join(root, value)),
], { encoding: 'utf8' })
if (compiled.status !== 0) {
  process.stderr.write(compiled.stdout + compiled.stderr)
  process.exit(1)
}

const require = createRequire(import.meta.url)
const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const contracts = require(path.join(out, 'contracts/telegram-channel/v1/index.js'))
const handlers = require(path.join(out, 'modules/telegram-channel/public/v1/manual-driver-telegram-link-handler.js'))
const notificationHandlers = require(path.join(out, 'modules/telegram-channel/public/v1/manual-driver-telegram-link-notification-handler.js'))
const checks = []
const check = (name, fn) => { fn(); checks.push(name) }
const checkAsync = async (name, fn) => { await fn(); checks.push(name) }

function transpile(relative) {
  return typescript.transpileModule(read(relative), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  }).outputText
}

function loadPersistenceAdapter(prisma) {
  const module = { exports: {} }
  vm.runInNewContext(transpile(paths.adapter), {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === '@/lib/prisma') return { prisma }
      throw new Error(`unexpected persistence import: ${specifier}`)
    },
  })
  return module.exports.legacyPrismaManualDriverTelegramLinkPortV1
}

function loadNotificationAdapter(fetch) {
  const module = { exports: {} }
  vm.runInNewContext(transpile(paths.notificationAdapter), {
    module,
    exports: module.exports,
    fetch,
    process: { env: { BOT_API_URL: 'https://bot.internal/api/bot' } },
    require() { throw new Error('notification adapter must not have runtime imports') },
  })
  return module.exports.legacyBotApiManualDriverTelegramLinkNotificationPortV1
}

const saveCommand = {
  contract: contracts.SAVE_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1,
  driverId: 'driver-1',
  telegramId: 42n,
}
const removeCommand = {
  contract: contracts.REMOVE_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1,
  driverId: 'driver-1',
}
const notifyCommand = {
  contract: contracts.NOTIFY_MANUAL_DRIVER_TELEGRAM_LINK_COMMAND_V1,
  telegramId: 42n,
  driverName: 'Driver One',
}

try {
  check('three exact manual-link identities and public facades are exported', () => {
    assert.equal(saveCommand.contract, 'telegram_channel.SaveManualDriverTelegramLinkCommand.v1')
    assert.equal(removeCommand.contract, 'telegram_channel.RemoveManualDriverTelegramLinkCommand.v1')
    assert.equal(notifyCommand.contract, 'telegram_channel.NotifyManualDriverTelegramLinkCommand.v1')
    assert.match(read(paths.contractIndex), /export \* from '\.\/manual-driver-telegram-link-commands'/)
    const publicIndex = read(paths.publicIndex)
    assert.match(publicIndex, /saveManualDriverTelegramLinkV1=/)
    assert.match(publicIndex, /removeManualDriverTelegramLinkV1=/)
    assert.match(publicIndex, /notifyManualDriverTelegramLinkV1=/)
  })

  check('strict parsers accept exact values and reject widening', () => {
    assert.deepEqual(contracts.parseSaveManualDriverTelegramLinkCommandV1(saveCommand), saveCommand)
    assert.deepEqual(contracts.parseRemoveManualDriverTelegramLinkCommandV1(removeCommand), removeCommand)
    assert.deepEqual(contracts.parseNotifyManualDriverTelegramLinkCommandV1(notifyCommand), notifyCommand)
    assert.throws(() => contracts.parseSaveManualDriverTelegramLinkCommandV1({ ...saveCommand, sql: 'x' }))
    assert.throws(() => contracts.parseSaveManualDriverTelegramLinkCommandV1({ ...saveCommand, telegramId: '42' }))
    assert.throws(() => contracts.parseRemoveManualDriverTelegramLinkCommandV1({ ...removeCommand, driverId: ' ' }))
    assert.throws(
      () => contracts.parseNotifyManualDriverTelegramLinkCommandV1({ ...notifyCommand, contract: 'telegram_channel.NotifyManualDriverTelegramLinkCommand.v2' }),
      (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    )
    assert.doesNotThrow(() => contracts.parseNotifyManualDriverTelegramLinkCommandV1({ ...notifyCommand, driverName: ' ' }))
  })

  await checkAsync('handlers validate first and map only closed owner inputs', async () => {
    const calls = []
    const port = {
      async save(input) { calls.push(['save', input]) },
      async remove(driverId) { calls.push(['remove', driverId]) },
    }
    const notificationPort = { async notify(input) { calls.push(['notify', input]) } }
    assert.equal((await handlers.createSaveManualDriverTelegramLinkHandlerV1(port)(saveCommand)).saved, true)
    assert.equal((await handlers.createRemoveManualDriverTelegramLinkHandlerV1(port)(removeCommand)).removed, true)
    assert.equal((await notificationHandlers.createNotifyManualDriverTelegramLinkHandlerV1(notificationPort)(notifyCommand)).notified, true)
    assert.deepEqual(calls.map(([kind]) => kind), ['save', 'remove', 'notify'])
    assert.deepEqual(calls[0][1], { driverId: 'driver-1', telegramId: 42n })
    assert.equal(calls[1][1], 'driver-1')
    assert.deepEqual(calls[2][1], { telegramId: 42n, driverName: 'Driver One' })
  })

  await checkAsync('invalid commands never persist and owner failures stay visible', async () => {
    let called = false
    const port = {
      async save() { called = true; throw new Error('save down') },
      async remove() { called = true; throw new Error('remove down') },
    }
    await assert.rejects(
      handlers.createSaveManualDriverTelegramLinkHandlerV1(port)({ ...saveCommand, telegramId: '42' }),
    )
    assert.equal(called, false)
    await assert.rejects(handlers.createSaveManualDriverTelegramLinkHandlerV1(port)(saveCommand), /save down/)
    await assert.rejects(handlers.createRemoveManualDriverTelegramLinkHandlerV1(port)(removeCommand), /remove down/)
  })

  await checkAsync('owner persistence adapter preserves exact upsert and delete shapes', async () => {
    const calls = []
    const prisma = { driverTelegram: {
      async upsert(input) { calls.push(['upsert', input]) },
      async delete(input) { calls.push(['delete', input]) },
    } }
    const adapter = loadPersistenceAdapter(prisma)
    await adapter.save({ driverId: 'driver-1', telegramId: 42n })
    await adapter.remove('driver-1')
    assert.deepEqual(calls.map(([kind]) => kind), ['upsert', 'delete'])
    assert.equal(calls[0][1].where.driverId, 'driver-1')
    assert.deepEqual(Object.keys(calls[0][1].update), ['telegramId'])
    assert.deepEqual(Object.keys(calls[0][1].create).sort(), ['driverId', 'telegramId'])
    assert.equal(calls[0][1].update.telegramId, 42n)
    assert.equal(calls[1][1].where.driverId, 'driver-1')
  })

  await checkAsync('Telegram owner notification preserves payload and ignores non-2xx status', async () => {
    const calls = []
    const adapter = loadNotificationAdapter(async (...args) => {
      calls.push(args)
      return { ok: false, status: 503 }
    })
    await adapter.notify({ telegramId: 42n, driverName: 'Driver One' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'https://bot.internal/api/bot/send-message')
    assert.equal(calls[0][1].method, 'POST')
    assert.deepEqual(JSON.parse(calls[0][1].body), {
      chatId: '42',
      text: '✅ Ваш профиль водителя успешно привязан к Telegram!\n\nВодитель: *Driver One*\n\nТеперь вы можете использовать кнопку «💳 Управление лимитом» в меню бота.',
    })
    assert.doesNotMatch(read(paths.notificationAdapter), /response\.ok|\bcatch\b/)
  })

  check('Platform orchestration uses only Telegram public commands and preserves legacy boundaries', () => {
    const source = read(paths.orchestrator)
    assert.match(source, /from '@\/modules\/telegram-channel\/public\/v1'/)
    assert.doesNotMatch(source, /@\/lib\/prisma|\bprisma\.|BOT_API_URL|\bfetch\s*\(/)
    assert.ok(source.indexOf('saveManualDriverTelegramLinkV1({') < source.indexOf('notifyManualDriverTelegramLinkV1({'))
    assert.ok(source.indexOf('notifyManualDriverTelegramLinkV1({') < source.indexOf('revalidateDriver(input.driverId)'))
    assert.match(source, /errorCode\(error\) === 'P2002'/)
    assert.match(source, /errorTargetIncludes\(error, 'telegramId'\)/)
    assert.match(source, /errorCode\(error\) === 'P2025'/)
    assert.doesNotMatch(source, /Promise\.all|\$transaction|\bretry\b/)
  })

  check('route is same-origin JSON-only and client crosses by URL with explicit refresh parity', () => {
    const route = read(paths.route)
    const client = read(paths.client)
    assert.match(route, /isSameOriginMutationRequest/)
    assert.match(route, /x-forwarded-host/)
    assert.match(route, /x-forwarded-proto/)
    assert.match(route, /forwardedHost\.toLowerCase\(\) !== host\.toLowerCase\(\)/)
    assert.match(route, /parsedOrigin\.protocol === `\$\{protocol\}:`/)
    assert.match(route, /parsedOrigin\.host\.toLowerCase\(\) === host\.toLowerCase\(\)/)
    assert.match(route, /application\/json/)
    assert.match(route, /status: 403/)
    assert.match(route, /status: 415/)
    assert.match(client, /fetch\(endpoint, \{/)
    assert.match(client, /method: 'POST'/)
    assert.match(client, /method: 'DELETE'/)
    assert.match(client, /if \(res\.mutated\) router\.refresh\(\)/)
    assert.doesNotMatch(client, /from '.\/actions'|modules\/platform-shell|modules\/telegram-channel/)
  })

  check('legacy action is retired while caller-owned read and client UI behavior remain', () => {
    assert.equal(existsSync(path.join(root, paths.legacyAction)), false)
    assert.match(read(paths.page), /prisma\.driverTelegram\.findFirst\(\{ where: \{ driverId: id \} \}\)/)
    const client = read(paths.client)
    assert.match(client, /if \(!telegramId\.trim\(\)\) return/)
    assert.match(client, /confirm\('Отвязать Telegram от этого водителя\?'\)/)
    assert.match(client, /e\.target\.value\.replace\(\/\\D\/g, ''\)/)
    assert.match(client, /setSuccess\('Telegram ID успешно привязан'\)/)
    assert.match(client, /setSuccess\('Telegram ID успешно отвязан'\)/)
  })

  check('new route classifies as Platform and creates no static Fleet reverse dependency', () => {
    const rules = JSON.parse(read('architecture/evidence/v1/module-rules.json')).modules
    const routeRule = rules.find((rule) => new RegExp(rule.match).test(paths.route))
    assert.equal(routeRule?.id, 'gravity_core')
    assert.equal(routeRule?.context, 'core')
    const fleetSources = read(paths.client) + read(paths.page)
    assert.doesNotMatch(fleetSources, /modules\/(?:platform-shell|telegram-channel)/)
  })
} finally {
  rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
