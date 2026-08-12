#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/contacts/yandex-link.ts'
const publicPath = 'gravity-mvp/src/modules/contacts/public/v1/yandex-driver-contact-link.ts'
const consumerPath = 'gravity-mvp/src/app/drivers/actions.ts'
const exactCapabilities = ['linkContactToBestDriver']

assert.equal(sha256(read(implementationPath)), 'a0ac8711a602ec8f6b7bbf3839afbf8ccb55cf6eccfd9e79d749012363a18018')

function capabilityKeys(source) {
    const body = source.match(/Object\.freeze\(\{([\s\S]*?)\}\)/)?.[1] ?? ''
    return [...body.matchAll(/^ {4}(\w+):/gm)].map((match) => match[1]).sort()
}

const publicSource = read(publicPath)
assert.deepEqual(capabilityKeys(publicSource), exactCapabilities)
assert.match(publicSource, /linkContactToBestDriver\(phone\)/)
assert.doesNotMatch(publicSource, /findDrivers|findContacts|updateContact|createContact|\bprisma\b|export \*/)
const unrelatedWriteProbe = publicSource.replace(
    /\n\}\)\n$/,
    "\n    updateContact: (contactId, patch) => updateContact(contactId, patch),\n})\n",
)
assert.notDeepEqual(capabilityKeys(unrelatedWriteProbe), exactCapabilities)

const consumer = read(consumerPath)
assert.match(consumer, /@\/modules\/contacts\/public\/v1\/yandex-driver-contact-link/)
assert.match(consumer, /yandexDriverContactLinkV1\.linkContactToBestDriver\(phone\)/)
assert.doesNotMatch(consumer, /@\/lib\/contacts\/yandex-link/)

const contactsManifest = JSON.parse(read('architecture/contexts/v1/manifests/contacts.json'))
const fleetManifest = JSON.parse(read('architecture/contexts/v1/manifests/fleet_operations.json'))
assert(contactsManifest.public_surface.includes('YandexDriverContactLink.v1'))
assert(fleetManifest.allowed_dependencies.some((dependency) => (
    dependency.context === 'contacts' && dependency.surface === 'contacts.public'
)))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    finding.file === consumerPath && finding.details?.target === implementationPath
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: 1,
    write_capabilities: exactCapabilities.length,
    negative_unrelated_write_probe: 'REJECTED',
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
