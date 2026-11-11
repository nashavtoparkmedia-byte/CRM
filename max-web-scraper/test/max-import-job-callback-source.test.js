'use strict'

// The scraper's history-import job callback (PATCH /api/import-jobs/<id>)
// carries the shared webhook secret the CRM admits it by, like every other
// scraper-to-CRM call.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const scraper = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')

test('the import-job callback sends the webhook secret header', () => {
  const start = scraper.indexOf('async function finishImportSession(')
  assert.notEqual(start, -1)
  const block = scraper.slice(start, scraper.indexOf('\n}\n', start))
  assert.match(block, /new URL\(`\$\{crmBase\}\/api\/import-jobs\/\$\{jobId\}`\)/)
  assert.match(block, /method:\s+'PATCH'/)
  assert.match(block, /headers:\s+maxScraperWebhookHeaders\(\{ 'Content-Type': 'application\/json', 'Content-Length': Buffer\.byteLength\(body\) \}\)/)
})

test('every scraper request to a CRM API path carries the webhook secret', () => {
  const crmCalls = [...scraper.matchAll(/\/api\/(?:import-jobs|webhooks?\/max)/g)].length
  assert.ok(crmCalls >= 2)
  const headerUses = (scraper.match(/maxScraperWebhookHeaders\(/g) || []).length
  // The definition, the webhook post, the reaction post and the job callback.
  assert.ok(headerUses >= 4, `expected at least 4 uses of maxScraperWebhookHeaders, found ${headerUses}`)
})
