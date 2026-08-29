#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const oldTargets = [
  'gravity-mvp/src/lib/opsLog.ts',
  'gravity-mvp/src/lib/phoneUtils.ts',
]

const phone = read('gravity-mvp/src/modules/contacts/public/v1/phone-identity.ts')
assert.match(phone, /export function normalizePhoneE164/)
assert.match(phone, /export function parseExternalChatId/)
assert.doesNotMatch(phone, /@\/lib\/phoneUtils|export \*|prisma|next\//i)
const legacyPhone = read('gravity-mvp/src/lib/phoneUtils.ts')
assert.match(legacyPhone, /@deprecated/)
assert.match(legacyPhone, /@\/modules\/contacts\/public\/v1\/phone-identity/)

const operational = read('gravity-mvp/src/infrastructure/operations/operational-log.ts')
assert.match(operational, /export function operationalLogV1/)
assert.doesNotMatch(
  operational,
  /export \*|function\s+\w*(?:transport|sink)|interface\s+\w*(?:Transport|Sink)|\btransport\??:|\bsink\??:/i,
)

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
assert.equal(registry.exceptions.filter((entry) =>
  oldTargets.some((target) => entry.subject.endsWith(`:${target}`))).length, 0)
const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => oldTargets.includes(finding.details?.target)), [])

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  retired_findings: 58,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
