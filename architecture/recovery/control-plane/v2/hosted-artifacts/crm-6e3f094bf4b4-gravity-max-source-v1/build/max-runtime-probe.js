'use strict'

const crypto = require('crypto')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { chromium } = require('playwright')

const sha256 = (path) => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')
const forbidden = [
  '/app/.env',
  '/app/.env.local',
  '/app/test',
  '/app/scripts',
  '/app/debug.js',
  '/app/discovery',
  '/app/check-contacts.js',
  '/app/maxBrowser.js',
]
const browser = chromium.executablePath()

const main = async () => {
  const uid = process.getuid()
  const gid = process.getgid()
  const userData = fs.statSync('/app/user_data')
  const mode = userData.mode & 0o777
  const groups = new Set(process.getgroups())
  const writableByRuntimeIdentity = userData.uid === uid
    ? Boolean(mode & 0o200)
    : groups.has(userData.gid)
      ? Boolean(mode & 0o020)
      : Boolean(mode & 0o002)
  const context = await chromium.launchPersistentContext('/tmp/yoko-max-release-probe-profile', {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    env: { ...process.env, HOME: '/tmp' },
  })
  await context.close()
  const value = {
    schema: 'yoko.crm.max-release-runtime-probe.v1',
    uid,
    gid,
    cwd: process.cwd(),
    index_sha256: sha256('/app/index.js'),
    package_lock_sha256: sha256('/app/package-lock.json'),
    tini_version: execFileSync('/usr/bin/tini', ['--version'], { encoding: 'utf8' }).trim(),
    browser_executable: browser,
    browser_version: execFileSync(browser, ['--version'], { encoding: 'utf8' }).trim(),
    playwright_module: require.resolve('playwright'),
    browser_launch: 'PASS',
    user_data: {
      path: '/app/user_data',
      type: userData.isDirectory() ? 'directory' : 'other',
      uid: userData.uid,
      gid: userData.gid,
      mode: mode.toString(8).padStart(4, '0'),
      writable_by_runtime_identity: writableByRuntimeIdentity,
      entries: fs.readdirSync('/app/user_data').sort(),
    },
    forbidden_paths_present: forbidden.filter(path => fs.existsSync(path)),
    environment: {
      NODE_ENV: process.env.NODE_ENV,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      TZ: process.env.TZ,
    },
  }
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

main().catch(error => {
  process.stderr.write(`MAX runtime probe failed: ${error.message}\n`)
  process.exitCode = 1
})
