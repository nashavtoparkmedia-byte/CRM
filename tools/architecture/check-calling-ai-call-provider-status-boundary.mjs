#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/ai-call/keys-status.ts'
const publicPath = 'gravity-mvp/src/modules/calling/public/v1/ai-call-provider-status.ts'
const consumers = [
    'gravity-mvp/src/app/api/settings/ai-call-keys/route.ts',
    'gravity-mvp/src/app/settings/integrations/ai-call-keys/AiCallKeysClient.tsx',
    'gravity-mvp/src/app/settings/integrations/ai-call-scenarios/AiCallScenariosClient.tsx',
    'gravity-mvp/src/app/settings/integrations/ai-call-scenarios/page.tsx',
]

assert.equal(sha256(read(implementationPath)), '396871f37acf871fbf1ea65d5330901fcca0ca6424ecafde761934f7f22daae5')

const publicSource = read(publicPath)
assert.match(publicSource, /getAiCallKeysStatus as getAiCallProviderStatusV1/)
assert.match(publicSource, /AiCallKeysStatus as AiCallProviderStatusV1/)
assert.match(publicSource, /KeyStatus as AiCallProviderKeyStatusV1/)
assert.doesNotMatch(publicSource, /export \*|maskSecret|getStatus|provider-settings|crypto/)

for (const consumer of consumers) {
    const source = read(consumer)
    assert.match(source, /@\/modules\/calling\/public\/v1\/ai-call-provider-status/)
    assert.doesNotMatch(source, /@\/lib\/ai-call\/keys-status/)
}

const route = read(consumers[0])
assert(route.indexOf('getCurrentUser()') < route.indexOf('getAiCallProviderStatusV1()'))
assert(route.indexOf("user.role !== 'Администратор'") < route.indexOf('getAiCallProviderStatusV1()'))

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/calling.json'))
assert(manifest.public_surface.includes('AiCallProviderStatus.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    consumers.includes(finding.file)
    && (finding.details?.target === implementationPath || finding.details?.target === publicPath)
)), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    consumers: consumers.length,
    plaintext_exports: 0,
    current_findings: scan.findings.length,
}, null, 2)}\n`)
