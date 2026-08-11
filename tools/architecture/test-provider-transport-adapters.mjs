#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (file) => readFileSync(path.join(root, file), 'utf8')
const legacyConsumers = [
  'gravity-mvp/src/modules/calling/public/v1/openai-chat-completion.ts',
  'yandex-fleet-scraper/src/api.ts',
  'yandex-fleet-scraper/src/worker.ts',
]
for (const consumer of legacyConsumers) {
  assert.doesNotMatch(read(consumer), /(?:from\s+['"](?:@aws-sdk\/|openai|bullmq|ioredis)|require\(['"]@aws-sdk\/)/)
}
assert.match(read('gravity-mvp/src/infrastructure/providers/openai-client.ts'), /from 'openai'/)
const fleetTransport = read('yandex-fleet-scraper/src/infrastructure/bullmq.ts')
assert.match(fleetTransport, /from 'bullmq'/)
assert.match(fleetTransport, /from 'ioredis'/)
assert.doesNotMatch(fleetTransport, /export \*|\bany\b|Record\s*</)
process.stdout.write(JSON.stringify({ status: 'PASS', consumers: legacyConsumers.length, designatedAdapters: 2 }) + '\n')
