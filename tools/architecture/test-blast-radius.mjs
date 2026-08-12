#!/usr/bin/env node

import assert from 'node:assert/strict'

import {
  compileBlastRadiusMetadata,
  computeBlastRadius,
  contextForChangedPath,
} from './check-blast-radius.mjs'
import { GIT_DIFF_FILTER, resolveGitDiffBase } from './git-change-set.mjs'

const manifests = [
  { context: { id: 'contacts' }, technical_modules: ['contacts'], allowed_dependencies: [] },
  { context: { id: 'messaging' }, technical_modules: ['messages'], allowed_dependencies: [{ context: 'contacts' }] },
]
const metadata = compileBlastRadiusMetadata({ modules: [
  { id: 'contacts', context: 'contacts', match: '^gravity-mvp/src/app/contacts/' },
  { id: 'messages', context: 'messages', match: '^gravity-mvp/src/app/messages/' },
] }, manifests, [
  'tools/architecture/check-contact-service-public-boundary.mjs',
  'tools/architecture/check-messaging-message-stream-boundary.mjs',
])

assert.equal(contextForChangedPath('gravity-mvp/src/modules/contacts/public/v1/index.ts', metadata), 'contacts')
assert.equal(contextForChangedPath('gravity-mvp/src/contracts/contacts/v1/index.ts', metadata), 'contacts')
assert.equal(contextForChangedPath('gravity-mvp/src/app/messages/page.tsx', metadata), 'messaging')
const radius = computeBlastRadius(['gravity-mvp/src/modules/contacts/public/v1/index.ts'], metadata)
assert.deepEqual(radius.owner_contexts, ['contacts'])
assert.deepEqual(radius.consumer_contexts, ['messaging'])
assert(radius.required_checks.includes('node tools/architecture/check-contact-service-public-boundary.mjs'))
assert.throws(() => computeBlastRadius(['gravity-mvp/src/unowned/new.ts'], metadata), /outside deterministic/)
const global = computeBlastRadius(['tools/architecture/enforce-architecture.mjs'], metadata)
assert.deepEqual(global.affected_contexts, ['contacts', 'messaging'])
assert.equal(resolveGitDiffBase(process.cwd(), '0'.repeat(40)), 'HEAD^')
assert.match(GIT_DIFF_FILTER, /D/u)

process.stdout.write('blast-radius mapping: PASS (5 mappings; deleted paths retained; unclassified production path rejected; invalid event base resolved)\n')
