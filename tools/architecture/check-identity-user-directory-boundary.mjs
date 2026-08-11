#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const target = 'gravity-mvp/src/lib/users/user-service.ts'
const publicDirectory = read('gravity-mvp/src/modules/identity-access/public/v1/user-directory.ts')

assert.match(publicDirectory, /CURRENT_USER_QUERY_V1/)
assert.match(publicDirectory, /LIST_USER_IDENTITIES_QUERY_V1/)
assert.match(publicDirectory, /getCurrentUserIdentityV1/)
assert.match(publicDirectory, /listUserIdentitiesV1/)
assert.doesNotMatch(publicDirectory, /@\/lib\/users|fs\/promises|next\/headers|export \*|Record<|\bany\b/)

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
assert.equal(registry.exceptions.filter((entry) => entry.subject.endsWith(`:${target}`)).length, 0)
const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => finding.details?.target === target), [])

const calling = JSON.parse(read('architecture/contexts/v1/manifests/calling.json'))
assert.equal(calling.allowed_dependencies.filter((entry) => entry.context === 'identity_access').length, 1)
const identity = JSON.parse(read('architecture/contexts/v1/manifests/identity_access.json'))
assert.ok(identity.public_surface.includes('ListUserIdentitiesQuery.v1'))

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  query_operations: 2,
  retired_findings: 63,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
