const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  MIN_NAVIGATION_QUIET_MS,
  attestDomRead,
  domCandidateExtraction,
  exactRoutePathname,
  exactUiRoutePath,
  pageSample,
} = require('../lib/DomRouteAttestation')

const ROUTE = '511708938'

function sample(overrides = {}) {
  return pageSample({
    url: `https://web.max.ru/${ROUTE}`,
    uiRouteId: ROUTE,
    uiSendInProgress: false,
    dialogBusy: false,
    uiSendEpoch: 7,
    navigationEpoch: 41,
    lastNavigationAt: 1_000,
    now: 1_000 + MIN_NAVIGATION_QUIET_MS + 1_800,
    ...overrides,
  })
}

function attested(overrides = {}) {
  return attestDomRead({
    uiRouteId: ROUTE,
    before: sample(overrides.before),
    readPathname: overrides.readPathname ?? `/${ROUTE}`,
    after: sample({ now: 9_999, ...overrides.after }),
  })
}

test('exact route path never accepts a substring of another route', () => {
  assert.equal(exactUiRoutePath('https://web.max.ru/66896', '66896'), true)
  assert.equal(exactUiRoutePath('https://web.max.ru/668961234', '66896'), false)
  assert.equal(exactUiRoutePath('https://web.max.ru/x/66896', '66896'), false)
  assert.equal(exactUiRoutePath('https://web.max.ru/', '66896'), false)
  assert.equal(exactUiRoutePath('https://web.max.ru/66896?from=list#m', '66896'), true)
  assert.equal(exactUiRoutePath('not a url', '66896'), false)
  assert.equal(exactUiRoutePath('https://web.max.ru/abc', 'abc'), false)
  assert.equal(exactUiRoutePath('https://web.max.ru/', ''), false)
  assert.equal(exactRoutePathname('/66896', '66896'), true)
  assert.equal(exactRoutePathname('/668961234', '66896'), false)
})

test('a quiet, idle page on the exact route before, during and after the read is attested', () => {
  assert.equal(attested(), true)
})

test('any page movement or competing page user around the read breaks the attestation', () => {
  const cases = {
    'route before differs': { before: { url: 'https://web.max.ru/668961234' } },
    'route after differs': { after: { url: 'https://web.max.ru/' } },
    'read pathname differs': { readPathname: '/201482140' },
    'read pathname missing': { readPathname: undefined, before: {}, after: {} },
    'UI send running before': { before: { uiSendInProgress: true } },
    'UI send running after': { after: { uiSendInProgress: true } },
    'phone lookup dialog before': { before: { dialogBusy: true } },
    'phone lookup dialog after': { after: { dialogBusy: true } },
    'UI send started and finished during the read': { after: { uiSendEpoch: 8 } },
    'navigation during the read (pushState, reload, goto)': { after: { navigationEpoch: 42 } },
    'page navigated less than the quiet period before the read': { before: { lastNavigationAt: 10_000, now: 10_000 + MIN_NAVIGATION_QUIET_MS - 1 } },
    'navigation time unknown': { before: { lastNavigationAt: undefined } },
    'flags not booleans': { before: { uiSendInProgress: 0 } },
  }
  for (const [label, overrides] of Object.entries(cases)) {
    const input = label === 'read pathname missing'
      ? attestDomRead({ uiRouteId: ROUTE, before: sample(), readPathname: undefined, after: sample() })
      : attested(overrides)
    assert.equal(input, false, label)
  }
  assert.equal(attestDomRead({ uiRouteId: ROUTE, before: null, readPathname: `/${ROUTE}`, after: sample() }), false)
})

test('only an element that is itself a message wrapper counts as a message element', () => {
  assert.equal(domCandidateExtraction(true), 'message_element')
  assert.equal(domCandidateExtraction(false), 'generic_text_rows')
  assert.equal(domCandidateExtraction(undefined), 'generic_text_rows')
  assert.equal(domCandidateExtraction('true'), 'generic_text_rows')
})

test('index.js wires the attestation into the DOM read, every page user and the webhook payload', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  assert.match(source, /require\('\.\/lib\/DomRouteAttestation'\)/)
  assert.match(source, /page\.on\('framenavigated'/)
  assert.equal((source.match(/uiSendInProgress = true\n\s*uiSendEpoch \+= 1/g) || []).length, 3)
  assert.match(source, /const readPathname = location\.pathname/)
  assert.match(source, /isMessageWrapper: message\.matches\('\[class\*="messageWrapper"\]'\)/)
  assert.match(source, /isMessageWrapper: false/)
  assert.match(source, /attestDomRead\(\{/)
  assert.match(source, /domRoute,/)
  assert.match(source, /extraction: latest\?\.extraction === 'message_element' \? 'message_element' : 'generic_text_rows',/)
  assert.match(source, /verified: latest\?\._domRoute\?\.verified === true\n\s*&& latest\._domRoute\.uiRouteId === String\(uiRouteId\)\n\s*&& String\(resolvedRoute\.uiRouteId\) === String\(uiRouteId\),/)
  assert.match(source, /extraction: domCandidateExtraction\(candidate\.isMessageWrapper\),/)
  assert.match(source, /_domRoute: \{ uiRouteId: String\(uiRouteId\), verified \},/)
  const scrape = source.slice(source.indexOf('async function scrapeRecentDomMessages'), source.indexOf('async function scrapeLatestDomMessage'))
  assert.ok(scrape.indexOf('const before = domPageSample(uiRouteId)') < scrape.indexOf('const candidates = await page.evaluate'))
  assert.ok(scrape.indexOf('const after = domPageSample(uiRouteId)') > scrape.indexOf('const candidates = await page.evaluate'))
})

test('the shared page is assigned once and its navigation counter is registered right after it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  assert.equal((source.match(/\bpage = /g) || []).length, 1)
  const assignment = source.indexOf('page = context.pages()[0] || await context.newPage()')
  const listener = source.indexOf("page.on('framenavigated'")
  assert.ok(assignment > 0 && listener > assignment && listener - assignment < 400)
  assert.match(source, /if \(frame !== page\.mainFrame\(\)\) return\n\s*mainFrameNavigationEpoch \+= 1\n\s*lastMainFrameNavigationAt = Date\.now\(\)/)
  assert.match(source, /dialogBusy: _dialogBusy/)
})
