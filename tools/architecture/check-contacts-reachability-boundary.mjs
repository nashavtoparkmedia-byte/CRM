#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/ReachabilityService.ts'
const publicPath = 'gravity-mvp/src/modules/contacts/public/v1/contact-reachability.ts'
const routePath = 'gravity-mvp/src/app/api/channels/check-reachability/route.ts'
const messageServicePath = 'gravity-mvp/src/lib/MessageService.ts'
const consumers = [routePath, messageServicePath]
const exactCapabilities = [
    'findIdentityByPhoneAndChannel',
    'isReachabilityConfirmed',
    'updateReachability',
    'updateReachabilityByChatId',
]

assert.equal(sha256(read(implementationPath)), 'a75d4de9cedae03d070b2a528ad43c698d4e1adb5c964f271062fec8e4e51bf8')

function capabilityKeys(source) {
    const body = source.match(/Object\.freeze\(\{([\s\S]*?)\}\)/)?.[1] ?? ''
    return [...body.matchAll(/^ {4}(\w+):/gm)].map((match) => match[1]).sort()
}

const publicSource = read(publicPath)
assert.deepEqual(capabilityKeys(publicSource), exactCapabilities)
assert.match(publicSource, /findIdentityByPhoneAndChannel\(phone, channel\)/)
assert.match(publicSource, /isReachabilityConfirmed\(identityId\)/)
assert.match(publicSource, /updateReachability\(identityId, status\)/)
assert.match(publicSource, /updateReachabilityByChatId\(chatId, status\)/)
assert.doesNotMatch(publicSource, /delete|merge|create|deactivate|\bprisma\b|export \*/)
const unrelatedWriteProbe = publicSource.replace(
    /\n\}\)\n$/,
    "\n    deactivateIdentity: (identityId) => deactivateIdentity(identityId),\n})\n",
)
assert.notDeepEqual(capabilityKeys(unrelatedWriteProbe), exactCapabilities)

const routeSource = read(routePath)
assert.match(routeSource, /@\/modules\/contacts\/public\/v1\/contact-reachability/)
assert.match(routeSource, /contactReachabilityV1\.findIdentityByPhoneAndChannel\(normalized, channel\)/)
assert.match(routeSource, /contactReachabilityV1\.isReachabilityConfirmed\(identityId\)/)
assert.match(routeSource, /contactReachabilityV1\.updateReachability\(identityId, result\.status\)/)
assert.doesNotMatch(routeSource, /\bprisma\b|@\/lib\/prisma/)

const messageServiceSource = read(messageServicePath)
assert.match(messageServiceSource, /@\/modules\/contacts\/public\/v1\/contact-reachability/)
assert.match(messageServiceSource, /contactReachabilityV1\.updateReachabilityByChatId\(currentChatId, 'unreachable'\)/)
assert.match(messageServiceSource, /contactReachabilityV1\.updateReachabilityByChatId\(currentChatId, 'confirmed'\)/)

for (const consumerPath of consumers) {
    assert.doesNotMatch(read(consumerPath), /@\/lib\/ReachabilityService/)
}

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/contacts.json'))
assert(manifest.public_surface.includes('ContactReachability.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    consumers.includes(finding.file) && finding.details?.target === implementationPath
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: consumers.length,
    reachability_capabilities: exactCapabilities.length,
    negative_unrelated_write_probe: 'REJECTED',
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
