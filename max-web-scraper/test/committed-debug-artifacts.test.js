'use strict'

// The scraper drives a logged-in MAX web session, so its debug output -
// screenshots, page dumps, QR images, run logs, backups - can carry personal
// data or a live login. None of it may be committed or reach the image.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..', '..')
const scraperDir = 'max-web-scraper'

const ARTIFACT_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|html?|txt|log|bak)$/i
const ARTIFACT_NAME = /^(last_qr|qr_page|max_dom_dump|debug_)/i

/** A path safe to print in a public CI log: long digit runs keep their last four. */
function masked(file) {
  return file.replace(/\d{5,}/g, digits => `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}`)
}

function trackedScraperFiles() {
  const git = spawnSync('git', ['ls-files', '-z', '--', scraperDir], { cwd: repoRoot, encoding: 'utf8' })
  if (git.status === 0) return git.stdout.split('\0').filter(Boolean)
  // Without git, every file on disk counts (fail-closed), runtime state excepted.
  const skip = new Set(['node_modules', 'user_data', 'media_storage', '.git'])
  const walk = dir => fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap(entry => {
    if (skip.has(entry.name)) return []
    const rel = path.posix.join(dir, entry.name)
    return entry.isDirectory() ? walk(rel) : [rel]
  })
  return walk(scraperDir)
}

test('no screenshot, page dump, QR image, run log or backup is committed under max-web-scraper', () => {
  const files = trackedScraperFiles()
  assert.ok(files.includes(`${scraperDir}/index.js`), 'the scraper sources are listed')
  const artifacts = files.filter(file => ARTIFACT_EXTENSION.test(file) || ARTIFACT_NAME.test(path.posix.basename(file)))
  assert.deepEqual(artifacts.map(masked), [], 'debug artifacts must not be committed')
})

test('.gitignore keeps debug artifacts out of git', () => {
  const lines = fs.readFileSync(path.join(repoRoot, scraperDir, '.gitignore'), 'utf8').split('\n').map(line => line.trim())
  for (const pattern of ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.html', '*.htm', '*.txt', '*.log', '*.bak', 'last_qr*', 'max_dom_dump*', 'user_data/', 'media_storage/']) {
    assert.ok(lines.includes(pattern), `.gitignore must list ${pattern}`)
  }
})

test('.dockerignore keeps images, dumps and runtime state out of the image at any depth', () => {
  const lines = fs.readFileSync(path.join(repoRoot, scraperDir, '.dockerignore'), 'utf8').split('\n').map(line => line.trim())
  for (const pattern of ['**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.webp', '**/*.html', '**/*.htm', '**/*.txt', '**/*.bak', 'last_qr*.png', 'userData', 'media_storage/', 'test/']) {
    assert.ok(lines.includes(pattern), `.dockerignore must list ${pattern}`)
  }
})
