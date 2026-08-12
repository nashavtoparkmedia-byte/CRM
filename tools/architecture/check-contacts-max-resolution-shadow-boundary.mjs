#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/contacts/max-contact-resolution-shadow.ts'
const typesPath = 'gravity-mvp/src/lib/contacts/contact-resolution-shadow.types.ts'
const publicPath = 'gravity-mvp/src/modules/contacts/public/v1/max-contact-resolution-shadow.ts'
const consumerPath = 'gravity-mvp/src/app/api/webhooks/max/route.ts'
const exactCapabilities = ['start']

assert.equal(sha256(read(implementationPath)), '4405d7431b341e45b77508da145f676f3c604069533a554ecddd96da5f93ba54')
assert.equal(sha256(read(typesPath)), 'c54d32c1d37c28e137554d57e0178a7ea5c120d973efb3d48c1ac871ce06442d')

function capabilityKeys(source) {
    const body = source.match(/Object\.freeze\(\{([\s\S]*?)\}\)/)?.[1] ?? ''
    return [...body.matchAll(/^ {4}(\w+):/gm)].map((match) => match[1]).sort()
}

const publicSource = read(publicPath)
assert.deepEqual(capabilityKeys(publicSource), exactCapabilities)
assert.match(publicSource, /startMaxContactResolutionShadow\(input\)/)
assert.match(publicSource, /export type \{ LegacyContactResolutionOutcome \}/)
assert.doesNotMatch(publicSource, /compareContactResolution|isMaxContactResolutionShadowEnabled|Dependencies|\bprisma\b|export \*/)
const unrelatedCapabilityProbe = publicSource.replace(
    /\n\}\)\n$/,
    "\n    compare: (plan, outcome) => compareContactResolution(plan, outcome),\n})\n",
)
assert.notDeepEqual(capabilityKeys(unrelatedCapabilityProbe), exactCapabilities)

const consumer = read(consumerPath)
assert.match(consumer, /@\/modules\/contacts\/public\/v1\/max-contact-resolution-shadow/)
assert.match(consumer, /maxContactResolutionShadowV1\.start\(\{/)
assert.doesNotMatch(consumer, /@\/lib\/contacts\/(?:max-contact-resolution-shadow|contact-resolution-shadow\.types)/)

const contactsManifest = JSON.parse(read('architecture/contexts/v1/manifests/contacts.json'))
const maxManifest = JSON.parse(read('architecture/contexts/v1/manifests/max_channel.json'))
assert(contactsManifest.public_surface.includes('MaxContactResolutionShadow.v1'))
assert(maxManifest.allowed_dependencies.some((dependency) => (
    dependency.context === 'contacts' && dependency.surface === 'contacts.public'
)))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    finding.file === consumerPath && [implementationPath, typesPath].includes(finding.details?.target)
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: 1,
    shadow_capabilities: exactCapabilities.length,
    negative_unrelated_capability_probe: 'REJECTED',
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
