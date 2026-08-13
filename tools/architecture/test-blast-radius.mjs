#!/usr/bin/env node

import assert from 'node:assert/strict'

import {
  compileBlastRadiusMetadata,
  computeBlastRadius,
  contextForChangedPath,
} from './check-blast-radius.mjs'
import { GIT_DIFF_FILTER, resolveGitDiffBase } from './git-change-set.mjs'

const verification = (id, moduleTest, consumers = [], providerScope = 'NOT_APPLICABLE', providerSiblings = []) => ({
  architecture_checks: ['node tools/architecture/enforce-architecture.mjs'],
  module_tests: [`node ${moduleTest}`],
  contract_tests: ['node tools/architecture/validate-contract-registry.mjs'],
  build_checks: ['node tools/architecture/check-typescript-baseline.mjs'],
  blast_radius: { owner_context: id, consumer_contexts: consumers, provider_scope: providerScope, provider_siblings: providerSiblings },
})
const manifests = [
  { context: { id: 'contacts' }, technical_modules: ['contacts'], allowed_dependencies: [], verification: verification('contacts', 'tools/architecture/check-contact-service-public-boundary.mjs', ['messaging']) },
  { context: { id: 'messaging' }, technical_modules: ['messages'], allowed_dependencies: [{ context: 'contacts' }], verification: verification('messaging', 'tools/architecture/check-messaging-message-stream-boundary.mjs', ['max_channel', 'telegram_channel', 'whatsapp_channel'], 'SHARED_PROVIDER_CONTRACT', ['max_channel', 'telegram_channel', 'whatsapp_channel']) },
  { context: { id: 'max_channel' }, technical_modules: ['max_provider'], allowed_dependencies: [{ context: 'messaging' }], verification: verification('max_channel', 'tools/architecture/check-messaging-max-message-boundary.mjs', [], 'PROVIDER_SPECIFIC') },
  { context: { id: 'telegram_channel' }, technical_modules: ['telegram_provider'], allowed_dependencies: [{ context: 'messaging' }], verification: verification('telegram_channel', 'tools/architecture/check-telegram-runtime-provider-boundary.mjs', [], 'PROVIDER_SPECIFIC') },
  { context: { id: 'whatsapp_channel' }, technical_modules: ['whatsapp_provider'], allowed_dependencies: [{ context: 'messaging' }], verification: verification('whatsapp_channel', 'tools/architecture/check-whatsapp-runtime-provider-boundary.mjs', [], 'PROVIDER_SPECIFIC') },
]
const metadata = compileBlastRadiusMetadata({ modules: [
  { id: 'contacts', context: 'contacts', match: '^gravity-mvp/src/app/contacts/' },
  { id: 'messages', context: 'messages', match: '^gravity-mvp/src/app/messages/' },
] }, manifests)

assert.equal(contextForChangedPath('gravity-mvp/src/modules/contacts/public/v1/index.ts', metadata), 'contacts')
assert.equal(contextForChangedPath('gravity-mvp/src/contracts/contacts/v1/index.ts', metadata), 'contacts')
assert.equal(contextForChangedPath('gravity-mvp/src/app/messages/page.tsx', metadata), 'messaging')
const radius = computeBlastRadius(['gravity-mvp/src/modules/contacts/public/v1/index.ts'], metadata)
assert.deepEqual(radius.owner_contexts, ['contacts'])
assert.deepEqual(radius.consumer_contexts, ['messaging'])
assert(radius.required_checks.includes('node tools/architecture/check-contact-service-public-boundary.mjs'))
assert.throws(() => computeBlastRadius(['gravity-mvp/src/unowned/new.ts'], metadata), /outside deterministic/)
const global = computeBlastRadius(['tools/architecture/enforce-architecture.mjs'], metadata)
assert.deepEqual(global.affected_contexts, ['contacts', 'max_channel', 'messaging', 'telegram_channel', 'whatsapp_channel'])
const maxOnly = computeBlastRadius(['gravity-mvp/src/modules/max-channel/public/v1/index.ts'], metadata)
assert(maxOnly.required_checks.includes('node tools/architecture/check-messaging-max-message-boundary.mjs'))
assert(!maxOnly.required_checks.includes('node tools/architecture/check-telegram-runtime-provider-boundary.mjs'))
assert(!maxOnly.required_checks.includes('node tools/architecture/check-whatsapp-runtime-provider-boundary.mjs'))
const sharedMessaging = computeBlastRadius(['gravity-mvp/src/modules/messaging/public/v1/index.ts'], metadata)
assert(sharedMessaging.required_checks.includes('node tools/architecture/check-messaging-max-message-boundary.mjs'))
assert(sharedMessaging.required_checks.includes('node tools/architecture/check-telegram-runtime-provider-boundary.mjs'))
assert(sharedMessaging.required_checks.includes('node tools/architecture/check-whatsapp-runtime-provider-boundary.mjs'))
assert.equal(resolveGitDiffBase(process.cwd(), '0'.repeat(40)), 'HEAD^')
assert.equal(resolveGitDiffBase(process.cwd(), ''), 'HEAD^')
assert.throws(
  () => resolveGitDiffBase(process.cwd(), 'f'.repeat(40)),
  /configured Git change-set base is not resolvable/u,
)
assert.match(GIT_DIFF_FILTER, /D/u)

process.stdout.write('blast-radius mapping: PASS (provider-specific isolation and shared-contract fanout enforced; deleted paths retained; unclassified production path rejected; empty/zero event bases resolve and missing nonzero bases fail closed)\n')
