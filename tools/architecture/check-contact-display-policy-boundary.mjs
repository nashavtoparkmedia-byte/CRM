#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const consumers = [
  'gravity-mvp/src/app/api/contacts/[id]/route.ts',
  'gravity-mvp/src/app/messages/components/ChatHeader.tsx',
  'gravity-mvp/src/app/messages/components/ContactProfileDrawer.tsx',
  'gravity-mvp/src/lib/MessageService.ts',
]

for (const consumer of consumers) {
  const source = read(consumer)
  assert.doesNotMatch(source, /@\/lib\/contactDisplay/)
  assert.match(source, /@\/modules\/contacts\/public\/v1\/contact-display-policy/)
}

const shim = read('gravity-mvp/src/lib/contactDisplay.ts')
assert.match(shim, /@\/modules\/contacts\/public\/v1\/contact-display-policy/)
assert.doesNotMatch(shim, /export \*/)

const policy = read('gravity-mvp/src/modules/contacts/public/v1/contact-display-policy.ts')
assert.doesNotMatch(policy, /@\/lib\/prisma|\$queryRaw|\$executeRaw|Service|Repository|export \*/)
assert.match(policy, /buildCanonicalContactSummary/)
assert.match(policy, /formatContactPhone/)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/contacts.json'))
assert(manifest.public_surface.includes('ContactDisplayPolicy.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file)
  && (finding.details?.target === 'gravity-mvp/src/lib/contactDisplay.ts'
    || finding.details?.target?.endsWith('/modules/contacts/public/v1/contact-display-policy.ts'))), [])

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const live = new Set(scan.findings.map((finding) => finding.fingerprint))
assert.equal(registry.exceptions.filter((entry) =>
  consumers.includes(entry.file) && !live.has(entry.fingerprint)).length, 0)

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
