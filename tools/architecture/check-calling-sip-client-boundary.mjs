#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const consumers = [
  'gravity-mvp/src/app/layout.tsx',
  'gravity-mvp/src/app/messages/components/NewChatPopover.tsx',
  'gravity-mvp/src/modules/calling/public/v1/client-ui/ActiveCallPopup.tsx',
  'gravity-mvp/src/modules/calling/public/v1/client-ui/CallButton.tsx',
  'gravity-mvp/src/modules/calling/public/v1/client-ui/CallToolbar.tsx',
  'gravity-mvp/src/modules/calling/public/v1/client-ui/IncomingCallPopup.tsx',
]

for (const consumer of consumers) {
  const source = read(consumer)
  assert.doesNotMatch(source, /@\/lib\/sip\/SipContext/)
  assert.match(source, /@\/modules\/calling\/public\/v1\/sip-client-context/)
}

const shim = read('gravity-mvp/src/lib/sip/SipContext.tsx')
assert.match(shim, /@\/modules\/calling\/public\/v1\/sip-client-context/)
assert.doesNotMatch(shim, /export \*/)

const capability = read('gravity-mvp/src/modules/calling/public/v1/sip-client-context.tsx')
assert.equal(
  createHash('sha256').update(capability).digest('hex'),
  '6cf74f4cb7d0d6b1701cba99f7d77ec38c812c4cee31254b33b3c22f40353009',
)
assert.match(capability, /CODEC_PRIORITY = \['PCMA', 'PCMU', 'telephone-event', 'CN'\]/)
assert.match(capability, /export function SipProvider/)
assert.match(capability, /export function useSip/)
assert.match(capability, /subscribeCallAlertAudioStatus/)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/calling.json'))
assert(manifest.public_surface.includes('SipClientContext.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file)
  && (finding.details?.target === 'gravity-mvp/src/lib/sip/SipContext.tsx'
    || finding.details?.target?.endsWith('/modules/calling/public/v1/sip-client-context.tsx'))), [])

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const live = new Set(scan.findings.map((finding) => finding.fingerprint))
assert.equal(registry.exceptions.filter((entry) =>
  consumers.includes(entry.file) && !live.has(entry.fingerprint)).length, 0)

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  implementation_sha256: '6cf74f4cb7d0d6b1701cba99f7d77ec38c812c4cee31254b33b3c22f40353009',
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
