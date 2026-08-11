#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const routePath = 'gravity-mvp/src/app/api/settings/ai-call-keys/route.ts'
const runtimePath = 'gravity-mvp/src/lib/openaiClient.ts'

const facade = read('gravity-mvp/src/modules/calling/public/v1/ai-call-provider-settings.ts')
assert.equal(sha256(facade), '342331d30f483a57ed33a17b7c49d179efd190f557b177b054276f3223566cac')
assert.match(facade, /import 'server-only'/)
assert.match(facade, /saveAiCallProviderSettingV1/)
assert.match(facade, /deleteAiCallProviderSettingV1/)
assert.match(facade, /getOpenAiRuntimeProviderCredentialV1/)
assert.match(facade, /return getValue\('openai', 'apiKey'\)/)
assert.doesNotMatch(facade, /export \*|getAllPlaintext|decrypt|encrypt|maskSecret|prisma|SettingRow/)

const implementation = read('gravity-mvp/src/lib/ai-call/provider-settings.ts')
assert.equal(sha256(implementation), '9d27230a216ddd74c368bbf62023eec934d0e314a70078cd8af454f88a54d892')

const route = read(routePath)
assert.match(route, /@\/modules\/calling\/public\/v1\/ai-call-provider-settings/)
assert.doesNotMatch(route, /@\/lib\/ai-call\/provider-settings/)
assert(route.indexOf('getCurrentUser()') < route.indexOf('saveAiCallProviderSettingV1('))
assert(route.indexOf("user.role !== 'Администратор'") < route.indexOf('saveAiCallProviderSettingV1('))
assert(route.indexOf('isValidPair(provider, key)') < route.indexOf('saveAiCallProviderSettingV1('))
assert(route.indexOf('if (!value.trim())') < route.indexOf('saveAiCallProviderSettingV1('))
assert(route.lastIndexOf("user.role !== 'Администратор'") < route.indexOf('deleteAiCallProviderSettingV1('))
assert(route.indexOf('!isValidPair(provider, key)') < route.indexOf('deleteAiCallProviderSettingV1('))

const runtime = read(runtimePath)
assert.match(runtime, /@\/modules\/calling\/public\/v1\/ai-call-provider-settings/)
assert.match(runtime, /getOpenAiRuntimeProviderCredentialV1\(\)/)
assert.doesNotMatch(runtime, /@\/lib\/ai-call\/provider-settings|getValue\('openai', 'apiKey'\)/)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/calling.json'))
assert(manifest.public_surface.includes('AiCallProviderSettings.v1'))

const consumers = [routePath, runtimePath]
const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file)
  && (finding.details?.target === 'gravity-mvp/src/lib/ai-call/provider-settings.ts'
    || finding.details?.target?.endsWith('/modules/calling/public/v1/ai-call-provider-settings.ts'))), [])

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const live = new Set(scan.findings.map((finding) => finding.fingerprint))
assert.equal(registry.exceptions.filter((entry) => !live.has(entry.fingerprint)).length, 0)

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  generic_plaintext_exports: 0,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
