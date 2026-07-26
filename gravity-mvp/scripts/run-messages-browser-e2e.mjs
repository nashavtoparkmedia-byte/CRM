import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PrismaClient } from '@prisma/client'
import puppeteer from 'puppeteer-core'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baseUrl = (process.env.MESSAGES_BROWSER_BASE_URL || 'http://codex-messages-browser-app:3002').replace(/\/$/, '')
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
const outputDir = path.resolve(
  process.env.MESSAGES_BROWSER_ARTIFACT_DIR
    || path.join(projectRoot, 'evidence', 'messages-browser', 'latest'),
)
const databaseUrl = process.env.DATABASE_URL || ''
const timeoutMs = Number(process.env.MESSAGES_BROWSER_TIMEOUT_MS || 60_000)

const fixture = {
  contacts: {
    remezov: 'browser-contact-remezov',
    shaburov: 'browser-contact-shaburov',
    addPhone: 'browser-contact-add-phone',
    otherOwner: 'browser-contact-other-owner',
    ambiguousOne: 'browser-contact-ambiguous-one',
    ambiguousTwo: 'browser-contact-ambiguous-two',
    sameNameOne: 'browser-contact-same-name-one',
    sameNameTwo: 'browser-contact-same-name-two',
    providerOnly: 'browser-contact-provider-only',
    mergeSource: 'browser-contact-merge-source',
    mergeTarget: 'browser-contact-merge-target',
    archivedSource: 'browser-contact-archived-source',
    canonicalTarget: 'browser-contact-canonical-target',
  },
  chats: {
    remezov: 'browser-chat-remezov-max',
    shaburov: 'browser-chat-shaburov-max',
    addPhone: 'browser-chat-add-phone-max',
    providerOnly: 'browser-chat-provider-only',
    canonicalLinked: 'browser-chat-canonical-linked',
  },
  phones: {
    same: '+79990000100',
    free: '+79990000101',
    other: '+79990000102',
    ambiguous: '+79990000103',
  },
}

function assertHarnessConfiguration() {
  if (!executablePath) throw new Error('PUPPETEER_EXECUTABLE_PATH is required')
  let parsed
  try {
    parsed = new URL(databaseUrl)
  } catch {
    throw new Error('DATABASE_URL must point to the isolated browser fixture database')
  }
  if (
    parsed.hostname !== 'codex-merge-test-postgres'
    || parsed.pathname !== '/crm_merge_test'
  ) {
    throw new Error(`Refusing browser mutations against ${parsed.hostname}${parsed.pathname}`)
  }
  const appUrl = new URL(baseUrl)
  if (appUrl.hostname !== 'codex-messages-browser-app') {
    throw new Error(`Refusing non-isolated application URL ${appUrl.hostname}`)
  }
}

assertHarnessConfiguration()
await fs.mkdir(outputDir, { recursive: true })

const prisma = new PrismaClient()
const consoleEvents = []
const pageErrors = []
const failedRequests = []
const scenarioResults = []
let browser
let page
let tracing = false

async function recordScenario(name, run) {
  const startedAt = Date.now()
  try {
    await run()
    scenarioResults.push({ name, status: 'PASS', durationMs: Date.now() - startedAt })
    console.log(`PASS ${name}`)
  } catch (error) {
    scenarioResults.push({
      name,
      status: 'FAIL',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    })
    if (page) {
      await page.screenshot({
        path: path.join(outputDir, `failure-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`),
        fullPage: true,
      }).catch(() => {})
    }
    throw error
  }
}

async function waitForVisibleText(text, timeout = timeoutMs) {
  await page.waitForFunction(
    expected => document.body?.innerText.includes(expected),
    { timeout },
    text,
  )
}

async function visibleText(selector = 'body') {
  return page.$eval(selector, element => element.innerText)
}

async function clickButton(text, scope = 'body', exact = true) {
  const clicked = await page.evaluate(({ label, rootSelector, exactMatch }) => {
    const root = document.querySelector(rootSelector)
    if (!root) return false
    const button = [...root.querySelectorAll('button')].find(candidate => {
      const candidateText = candidate.textContent?.replace(/\s+/g, ' ').trim() || ''
      return exactMatch ? candidateText === label : candidateText.includes(label)
    })
    if (!(button instanceof HTMLButtonElement)) return false
    button.click()
    return true
  }, { label: text, rootSelector: scope, exactMatch: exact })
  assert.equal(clicked, true, `button not found: ${text}`)
}

async function replaceInput(selector, value) {
  await page.focus(selector)
  await page.$eval(selector, input => {
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.type(selector, value)
}

async function openChat(chatId) {
  await page.goto(`${baseUrl}/messages?id=${encodeURIComponent(chatId)}&profile=1`, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  })
  await page.waitForSelector('[data-testid="contact-driver-profile-panel"]', { timeout: timeoutMs })
}

async function screenshot(name) {
  await page.screenshot({
    path: path.join(outputDir, `${name}.png`),
    fullPage: true,
  })
}

async function apiSearch(query) {
  return page.evaluate(async q => {
    const response = await fetch(`/api/contacts/search?q=${encodeURIComponent(q)}&limit=20`, {
      cache: 'no-store',
    })
    return { status: response.status, body: await response.json() }
  }, query)
}

async function openAddPhoneDialog() {
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')].some(button =>
      button.textContent?.replace(/\s+/g, ' ').trim().includes('Добавить номер'),
    ),
    { timeout: timeoutMs },
  )
  await clickButton('Добавить номер', 'body', false)
  await page.waitForSelector('[data-testid="add-phone-resolution-dialog"]', { timeout: timeoutMs })
}

async function closeAddPhoneDialog() {
  const dialog = '[data-testid="add-phone-resolution-dialog"]'
  const close = await page.$(`${dialog} button[aria-label="Закрыть"]`)
  assert(close, 'add-phone close button not found')
  await close.click()
  await page.waitForSelector(dialog, { hidden: true, timeout: timeoutMs })
}

async function submitPhonePreflight(phone) {
  await replaceInput('[data-testid="add-phone-resolution-dialog"] input[type="tel"]', phone)
  await clickButton('Проверить и добавить', '[data-testid="add-phone-resolution-dialog"]')
}

async function assertChannelRows() {
  for (const channel of ['max', 'telegram', 'whatsapp']) {
    const selector = `[data-channel-row="${channel}"]`
    await page.waitForSelector(selector, { timeout: timeoutMs })
    const rows = await page.$$eval(selector, elements => elements.map(element => {
      const action = element.querySelector('[data-channel-action]')
      return {
        actionTitle: action?.getAttribute('title') || '',
        canWrite: action?.getAttribute('data-channel-can-write') || null,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }
    }))
    assert.equal(rows.length, 1, `${channel} must have exactly one canonical row`)
    assert(rows[0].actionTitle.length > 0, `${channel} write action missing`)
    assert.equal(rows[0].canWrite, 'true', `${channel} write action must use its canonical route`)
    assert(rows[0].scrollWidth <= rows[0].clientWidth + 1, `${channel} row overflows`)
  }
}

try {
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
  page = await browser.newPage()
  page.setDefaultTimeout(timeoutMs)
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await page.setCookie({ name: 'crm_user_id', value: 'u1', url: baseUrl })

  page.on('console', message => {
    consoleEvents.push({
      type: message.type(),
      text: message.text(),
      url: message.location().url || null,
    })
  })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('requestfailed', request => {
    failedRequests.push({
      method: request.method(),
      url: request.url(),
      error: request.failure()?.errorText || 'unknown',
    })
  })

  await page.tracing.start({
    path: path.join(outputDir, 'chromium-trace.json'),
    screenshots: true,
  })
  tracing = true

  await recordScenario('remezov-six-parks', async () => {
    await openChat(fixture.chats.remezov)
    await waitForVisibleText('Ремезов Александр Сергеевич')
    const main = await visibleText('[data-testid="main-driver-profile"]')
    assert(main.includes('YOKO'), 'Remezov main profile must be YOKO')
    const panel = await visibleText('[data-testid="contact-driver-profile-panel"]')
    assert(panel.includes('Привязано профилей: 6'))
    assert(panel.includes('Профили водителя: 6 в 6 парках'))
    await assertChannelRows()

    const bot = await page.$('[data-telegram-bot-block]')
    assert(bot, 'Telegram Bot block missing')
    const botText = await visibleText('[data-telegram-bot-block]')
    assert(botText.includes('Связан'))
    assert(botText.includes('remezov_driver'))

    const warning = await visibleText('[data-testid="profile-sync-warning"]')
    assert(warning.includes('Не удалось обновить данные «Наш Автопарк».'))
    assert(warning.includes('Показана последняя сохранённая информация.'))
    const warningRetryDisabled = await page.$eval(
      '[data-testid="profile-sync-warning"] button',
      button => button.disabled,
    )
    assert.equal(warningRetryDisabled, true, 'retry must be disabled during backoff')

    const body = await visibleText()
    for (const raw of ['NASH_AVTOPARK', 'Yandex API 429', '"code":"429"', 'dismissed:']) {
      assert.equal(body.includes(raw), false, `raw operator-facing error leaked: ${raw}`)
    }

    await page.click('[data-testid="profiles-collapse-toggle"]')
    await page.waitForSelector('[data-testid="profiles-by-park"]')
    const parkNames = await page.$$eval('[data-testid="profiles-by-park"] [data-park]', elements =>
      elements.map(element => element.getAttribute('data-park')),
    )
    assert.deepEqual(
      new Set(parkNames),
      new Set(['Наш Автопарк', 'YOKO', 'YOKO-2', 'YOKO-3', 'YOKO-4', 'YOKO.Доставка']),
    )
    await screenshot('remezov-six-parks-desktop')
  })

  await recordScenario('shaburov-one-park', async () => {
    await openChat(fixture.chats.shaburov)
    await waitForVisibleText('Шабуров Евгений Анатольевич')
    const main = await visibleText('[data-testid="main-driver-profile"]')
    assert(main.includes('Наш Автопарк'))
    const panel = await visibleText('[data-testid="contact-driver-profile-panel"]')
    assert(panel.includes('Привязано профилей: 1'))
    assert(panel.includes('Профили водителя: 1 в 1 парке'))
    await assertChannelRows()
    const warning = await visibleText('[data-testid="profile-sync-warning"]')
    assert(warning.includes('Показана последняя сохранённая информация.'))
    const body = await visibleText()
    assert.equal(body.includes('Yandex API 429'), false)
    assert.equal(body.includes('NASH_AVTOPARK'), false)
    await screenshot('shaburov-one-park-desktop')
  })

  await recordScenario('canonical-search', async () => {
    const searchInput = 'input[placeholder="Поиск..."]'
    await replaceInput(searchInput, '9222155')
    await waitForVisibleText('Ремезов Александр Сергеевич')
    await replaceInput(searchInput, 'шабу')
    await waitForVisibleText('Шабуров Евгений Анатольевич')

    const cases = [
      ['+7 922 215-57-50', [fixture.contacts.remezov]],
      ['ремезов', [fixture.contacts.remezov]],
      ['remezov_driver', [fixture.contacts.remezov]],
      ['900000100001', [fixture.contacts.remezov]],
      ['remezov-yoko-profile', [fixture.contacts.remezov]],
      ['Алексей Тестов', [fixture.contacts.sameNameOne, fixture.contacts.sameNameTwo]],
      ['79990000103', [fixture.contacts.ambiguousOne, fixture.contacts.ambiguousTwo]],
    ]
    for (const [query, expectedIds] of cases) {
      const result = await apiSearch(query)
      assert.equal(result.status, 200, `search failed: ${query}`)
      const resultIds = result.body.contacts.map(contact => contact.id)
      for (const expectedId of expectedIds) {
        assert(resultIds.includes(expectedId), `${query} missing ${expectedId}`)
      }
    }
  })

  await recordScenario('add-phone-ownership', async () => {
    await openChat(fixture.chats.addPhone)

    await openAddPhoneDialog()
    await submitPhonePreflight(fixture.phones.same)
    await page.waitForSelector('[data-testid="phone-resolution-success"]')
    assert((await visibleText('[data-testid="phone-resolution-success"]')).includes('Этот номер уже добавлен'))
    const sameOffersOther = await page.evaluate(() =>
      [...document.querySelectorAll('button')].some(button =>
        button.textContent?.replace(/\s+/g, ' ').trim() === 'Открыть существующий контакт',
      ),
    )
    assert.equal(sameOffersOther, false, 'SAME_CONTACT must not be rendered as OTHER_CONTACT')
    await closeAddPhoneDialog()

    await openAddPhoneDialog()
    await submitPhonePreflight(fixture.phones.other)
    await waitForVisibleText('Номер уже используется')
    assert(await page.$(`[data-testid="phone-owner-${fixture.contacts.otherOwner}"]`))
    await closeAddPhoneDialog()

    await openAddPhoneDialog()
    await submitPhonePreflight(fixture.phones.ambiguous)
    await waitForVisibleText('Номер найден у нескольких контактов')
    assert(await page.$(`[data-testid="phone-owner-${fixture.contacts.ambiguousOne}"]`))
    assert(await page.$(`[data-testid="phone-owner-${fixture.contacts.ambiguousTwo}"]`))
    await closeAddPhoneDialog()

    await openAddPhoneDialog()
    await submitPhonePreflight(fixture.phones.free)
    await waitForVisibleText('Номер свободен и может быть добавлен')
    await clickButton('Добавить номер', '[data-testid="add-phone-resolution-dialog"]')
    await page.waitForSelector('[data-testid="phone-resolution-success"]')
    assert((await visibleText('[data-testid="phone-resolution-success"]')).includes('Номер добавлен'))

    const owners = await prisma.contactPhone.findMany({
      where: { phone: fixture.phones.free, isActive: true },
      select: { contactId: true },
    })
    assert.deepEqual(owners, [{ contactId: fixture.contacts.addPhone }])
    await closeAddPhoneDialog()
    await screenshot('add-phone-ownership-complete')
  })

  await recordScenario('add-phone-owner-contact-route', async () => {
    await openChat(fixture.chats.addPhone)
    const sourceChatBefore = await prisma.chat.findUniqueOrThrow({
      where: { id: fixture.chats.addPhone },
      select: { contactId: true },
    })

    await openAddPhoneDialog()
    await submitPhonePreflight(fixture.phones.other)
    await waitForVisibleText('Номер уже используется')
    await clickButton('Открыть существующий контакт', '[data-testid="add-phone-resolution-dialog"]')

    await page.waitForFunction(
      ({ ownerId, sourceChatId }) => {
        const params = new URL(window.location.href).searchParams
        return params.get('contact') === ownerId && params.get('id') === sourceChatId
      },
      { timeout: timeoutMs },
      { ownerId: fixture.contacts.otherOwner, sourceChatId: fixture.chats.addPhone },
    )
    await page.waitForFunction(
      ownerName => document.querySelector('[data-testid="contact-profile-title"]')
        ?.textContent?.includes(ownerName),
      { timeout: timeoutMs },
      'Другой владелец номера',
    )
    const ownerUrl = new URL(page.url())
    assert.equal(ownerUrl.searchParams.get('id'), fixture.chats.addPhone)
    assert.equal(ownerUrl.searchParams.get('contact'), fixture.contacts.otherOwner)
    assert((await visibleText()).includes('Проверка добавления номера'), 'source Chat must remain visible')
    const sourceChatAfter = await prisma.chat.findUniqueOrThrow({
      where: { id: fixture.chats.addPhone },
      select: { contactId: true },
    })
    assert.deepEqual(sourceChatAfter, sourceChatBefore, 'opening an owner must not move the source Chat')
    await screenshot('add-phone-other-owner-route')

    await page.goBack({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForFunction(
      sourceChatId => {
        const params = new URL(window.location.href).searchParams
        return params.get('id') === sourceChatId && !params.has('contact')
      },
      { timeout: timeoutMs },
      fixture.chats.addPhone,
    )
    await page.waitForFunction(
      sourceName => document.querySelector('[data-testid="contact-profile-title"]')
        ?.textContent?.includes(sourceName),
      { timeout: timeoutMs },
      'Контакт проверки телефона',
    )

    await page.goto(
      `${baseUrl}/messages?id=${fixture.chats.addPhone}&profile=1&contact=${fixture.contacts.archivedSource}`,
      { waitUntil: 'domcontentloaded', timeout: timeoutMs },
    )
    await page.waitForFunction(
      ({ canonicalId, sourceChatId }) => {
        const params = new URL(window.location.href).searchParams
        return params.get('contact') === canonicalId && params.get('id') === sourceChatId
      },
      { timeout: timeoutMs },
      { canonicalId: fixture.contacts.canonicalTarget, sourceChatId: fixture.chats.addPhone },
    )
    await page.waitForFunction(
      canonicalName => document.querySelector('[data-testid="contact-profile-title"]')
        ?.textContent?.includes(canonicalName),
      { timeout: timeoutMs },
      'Канонический связанный контакт',
    )
    assert((await visibleText()).includes('Проверка добавления номера'), 'canonical redirect must preserve the source Chat')
    await screenshot('add-phone-archived-owner-canonical-route')
  })

  await recordScenario('merge-api-and-redirect', async () => {
    const mergeResult = await page.evaluate(async ({ sourceId, targetId }) => {
      const previewResponse = await fetch(`/api/contacts/${sourceId}/merge-to/${targetId}`, {
        cache: 'no-store',
      })
      const preview = await previewResponse.json()

      const patchResponse = await fetch(`/api/contacts/${targetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Цель browser merge обновлена' }),
      })

      const execute = body => fetch(`/api/contacts/${sourceId}/merge-to/${targetId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const staleResponse = await execute(preview)
      const staleBody = await staleResponse.json()

      const freshPreviewResponse = await fetch(`/api/contacts/${sourceId}/merge-to/${targetId}`, {
        cache: 'no-store',
      })
      const freshPreview = await freshPreviewResponse.json()
      const executeResponse = await execute(freshPreview)
      const executeBody = await executeResponse.json()

      const sourceResponse = await fetch(`/api/contacts/${sourceId}`, { cache: 'no-store' })
      const sourceBody = await sourceResponse.json()
      const targetResponse = await fetch(`/api/contacts/${targetId}`, { cache: 'no-store' })
      const targetBody = await targetResponse.json()

      return {
        previewStatus: previewResponse.status,
        preview,
        patchStatus: patchResponse.status,
        staleStatus: staleResponse.status,
        staleBody,
        executeStatus: executeResponse.status,
        executeBody,
        sourceStatus: sourceResponse.status,
        sourceBody,
        targetStatus: targetResponse.status,
        targetBody,
      }
    }, {
      sourceId: fixture.contacts.mergeSource,
      targetId: fixture.contacts.mergeTarget,
    })

    assert.equal(mergeResult.previewStatus, 200)
    assert(mergeResult.preview.planHash)
    assert(mergeResult.preview.confirmationToken)
    assert.equal(mergeResult.patchStatus, 200)
    assert.equal(mergeResult.staleStatus, 409)
    assert.equal(mergeResult.staleBody.code, 'STALE_MERGE_PLAN')
    assert.equal(mergeResult.executeStatus, 200)
    assert.equal(mergeResult.executeBody.status, 'contact_merged')
    assert.equal(mergeResult.sourceStatus, 409)
    assert.equal(mergeResult.sourceBody.canonicalContactId, fixture.contacts.mergeTarget)
    assert.equal(mergeResult.targetStatus, 200)
    assert(mergeResult.targetBody.identities.some(identity => identity.externalId === '900000100301'))
    assert(mergeResult.targetBody.chats.some(chat => chat.id === 'browser-chat-merge-source'))

    const graph = {
      attachment: await prisma.messageAttachment.findUnique({ where: { id: 'browser-merge-attachment' } }),
      task: await prisma.task.findUnique({ where: { id: 'browser-merge-task' } }),
      call: await prisma.call.findUnique({ where: { id: 'browser-merge-call' } }),
      driver: await prisma.driver.findUnique({ where: { id: 'browser-driver-merge-source-nash_avtopark' } }),
      audit: await prisma.contactDriverProfileAudit.findUnique({ where: { id: 'browser-merge-profile-audit' } }),
      telegram: await prisma.driverTelegram.findUnique({ where: { id: 'browser-merge-driver-telegram' } }),
    }
    assert(graph.attachment)
    assert.equal(graph.task?.contactId, fixture.contacts.mergeTarget)
    assert.equal(graph.call?.contactId, fixture.contacts.mergeTarget)
    assert.equal(graph.driver?.contactId, fixture.contacts.mergeTarget)
    assert.equal(graph.audit?.contactId, fixture.contacts.mergeTarget)
    assert.equal(graph.telegram?.driverId, graph.driver?.id)
  })

  await recordScenario('provider-only-and-old-link', async () => {
    const contract = await page.evaluate(async ids => {
      const unresolvedResponse = await fetch(`/api/contacts/${ids.providerOnly}`, { cache: 'no-store' })
      const unresolved = await unresolvedResponse.json()
      const archivedResponse = await fetch(`/api/contacts/${ids.archivedSource}`, { cache: 'no-store' })
      const archived = await archivedResponse.json()
      return {
        unresolvedStatus: unresolvedResponse.status,
        unresolved,
        archivedStatus: archivedResponse.status,
        archived,
      }
    }, fixture.contacts)
    assert.equal(contract.unresolvedStatus, 200)
    assert.equal(contract.unresolved.phones.length, 0)
    assert(contract.unresolved.identities.some(identity => identity.externalId === 'max-provider-only'))
    assert.equal(contract.archivedStatus, 409)
    assert.equal(contract.archived.canonicalContactId, fixture.contacts.canonicalTarget)

    await openChat(fixture.chats.providerOnly)
    await waitForVisibleText('Неразрешённый MAX контакт')
    await openChat(fixture.chats.canonicalLinked)
    await waitForVisibleText('Канонический связанный контакт')
    await screenshot('provider-only-routing')
  })

  await recordScenario('responsive-layout', async () => {
    for (const viewport of [
      { width: 1280, height: 800, name: 'desktop-1280' },
      { width: 1024, height: 768, name: 'desktop-1024' },
    ]) {
      await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 })
      await openChat(fixture.chats.remezov)
      await assertChannelRows()
      const drawer = await page.$eval('[data-testid="contact-driver-profile-panel"]', element => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, right: rect.right, width: rect.width }
      })
      assert(drawer.width > 0)
      assert(drawer.right <= viewport.width + 1, `profile panel outside ${viewport.name}`)
      await screenshot(`remezov-${viewport.name}`)
    }
  })

  assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join('; ')}`)
  const failedApiRequests = failedRequests.filter(item =>
    item.url.startsWith(baseUrl)
    && item.url.includes('/api/')
    && item.error !== 'net::ERR_ABORTED',
  )
  assert.deepEqual(failedApiRequests, [], `failed API requests: ${JSON.stringify(failedApiRequests)}`)
} catch (error) {
  process.exitCode = 1
  console.error(error)
} finally {
  if (tracing && page) {
    await page.tracing.stop().catch(() => {})
  }
  const evidence = {
    status: process.exitCode ? 'FAIL' : 'PASS',
    generatedAt: new Date().toISOString(),
    baseUrl,
    executablePath,
    scenarios: scenarioResults,
    pageErrors,
    failedRequests,
    consoleEvents,
  }
  await fs.writeFile(
    path.join(outputDir, 'results.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  )
  await prisma.$disconnect().catch(() => {})
  await browser?.close().catch(() => {})
}

if (process.exitCode) process.exit(process.exitCode)
console.log(`REAL BROWSER PASS ${scenarioResults.length}/${scenarioResults.length}`)
