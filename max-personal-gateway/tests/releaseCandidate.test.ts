import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const source = (path: string) => readFileSync(resolve(root, path), 'utf8')

test('gateway image and runtime are browserless and contain no sender/provider/projection imports', () => {
  const dockerfile = source('max-personal-gateway/Dockerfile')
  assert.match(dockerfile, /^FROM node:22\.22\.2-alpine3\.23@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS runtime$/m)
  assert.match(dockerfile, /^USER node$/m)
  assert.doesNotMatch(dockerfile, /playwright|puppeteer|chromium/i)
  const runtime = execFileSync('bash', ['-lc', 'find max-personal-gateway/src/runtime -type f -print0 | sort -z | xargs -0 cat'], { cwd: root, encoding: 'utf8' })
  assert.doesNotMatch(runtime, /(?:from|require\()[^\n]*(?:\/outbound|\/dispatch|\/route|puppeteer|playwright)/i)
  assert.doesNotMatch(runtime, /sendFrame\(|page\.goto\(|chromium\.launch\(/)
})

test('compose overlay keeps ingress private and only scraper receives spool/profile-related storage', () => {
  const compose = source('deploy/docker-compose.stage8b1.shadow.yml')
  const gateway = compose.slice(compose.indexOf('  max-personal-gateway:'))
  assert.doesNotMatch(gateway, /^    ports:/m)
  assert.match(gateway, /^    expose:\n      - "8080"/m)
  assert.match(gateway, /crm_internal/)
  assert.doesNotMatch(gateway, /max_user_data|user_data|chromium|profile/i)
  assert.equal((compose.match(/\/var\/lib\/crm\/max-personal-capture:/g) ?? []).length, 1)
  assert.doesNotMatch(source('deploy/nginx/nginx.conf') + source('deploy/nginx/conf.d/default.conf'), /max-personal-gateway/)
})

test('Stage 8B1 source delta adds no browser/listener owner and preserves protected sender/projection paths', () => {
  const patch = execFileSync('git', ['diff', '--unified=0', '6d994070b1d56b1eaafa5fd5b495b6564a430c3c', '--', 'max-web-scraper', 'max-personal-gateway/src/runtime', 'deploy/docker-compose.stage8b1.shadow.yml'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const additions = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n')
  assert.doesNotMatch(additions, /launchPersistentContext\(|chromium\.launch|newCDPSession\(|webSocketFrameReceived\(/)
  assert.equal((source('max-web-scraper/index.js').match(/launchPersistentContext\(/g) ?? []).length, 1)
  assert.equal((source('max-web-scraper/transport/TransportInterceptor.js').match(/exposeFunction\('__maxWsReceive'/g) ?? []).length, 1)
  execFileSync('git', ['diff', '--quiet', '6d994070b1d56b1eaafa5fd5b495b6564a430c3c', '--',
    'max-web-scraper/lib/SerializedOutboundQueue.js', 'max-web-scraper/sync/MessageSync.js',
    'max-web-scraper/sync/InitialHistorySync.js', 'max-personal-gateway/src/outbound',
    'max-personal-gateway/src/route', 'gravity-mvp/src'], { cwd: root })
})

test('release package and rollback contract contain every owner gate without secrets', () => {
  const required = [
    'release-manifest.json', 'accepted-commit-chain.json', 'image-manifest.json', 'migration-manifest.json',
    'required-env.md', 'spool-mount.md', 'ingress-auth.md', 'compose-service-diff.md',
    'health-readiness.md', 'smoke-tests.md', 'rollback.md', 'owner-approval-gate.md',
    'no-provider-effects.md', 'stage8b2-sequence.md',
  ]
  const contents = required.map(name => source(`release/personal-max-stage8b1/${name}`)).join('\n')
  assert.match(contents, /disable flag.*stop drain.*preserve spool/is)
  assert.match(contents, /explicit.*approval/is)
  assert.match(contents, /no provider|provider actions.*prohibited/is)
  assert.doesNotMatch(contents, /-----BEGIN .*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^<\s]+:[^<\s]+@|Bearer\s+[A-Za-z0-9._-]{16,}/)
})
