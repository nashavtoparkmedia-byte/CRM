#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const defaultIndexRelative = 'architecture/contexts/v1/context-index.json'
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const SHA256 = /^[0-9a-f]{64}$/u
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}
const command = (checker) => `node tools/architecture/${checker}`
const minimizeOwnedPaths = (paths) => [...new Set(paths)]
  .sort((left, right) => left.length - right.length || left.localeCompare(right))
  .filter((candidate, index, values) => !values.slice(0, index).some((owner) => candidate === owner || candidate.startsWith(`${owner}/`)))
  .sort()
const moduleTests = {
  ai_knowledge: [
    command('check-ai-knowledge-governance-boundary.mjs'),
    command('check-ai-knowledge-retrieval-boundary.mjs'),
    command('check-ai-decision-boundary.mjs'),
  ],
  analytics_reporting: [command('check-analytics-dashboard-boundary.mjs')],
  avito_acquisition: [command('check-messaging-avito-chat-boundary.mjs')],
  calling: [
    command('check-calling-provider-runtime-boundary.mjs'),
    command('check-calling-ai-intern-control-boundary.mjs'),
    command('check-calling-messaging-timeline-boundary.mjs'),
  ],
  configuration: [
    command('check-configuration-operational-health-boundary.mjs'),
    command('check-configuration-operations-monitoring-policy-boundary.mjs'),
  ],
  contacts: [
    command('check-contact-service-public-boundary.mjs'),
    command('check-contacts-reachability-boundary.mjs'),
    command('check-contact-conversation-api-boundary.mjs'),
  ],
  edge_delivery: [command('check-calling-client-ui-boundary.mjs')],
  fleet_operations: [
    command('check-fleet-driver-action-boundary.mjs'),
    command('check-fleet-monitoring-policy-boundary.mjs'),
    command('check-yandex-fleet-operations-boundary.mjs'),
  ],
  identity_access: [
    command('check-identity-boundary.mjs'),
    command('check-identity-user-directory-boundary.mjs'),
  ],
  max_channel: [
    command('check-driver-max-messaging-boundary.mjs'),
    command('check-messaging-max-message-boundary.mjs'),
    command('check-messaging-max-attachments-boundary.mjs'),
  ],
  messaging: [
    command('check-messaging-message-stream-boundary.mjs'),
    command('check-messaging-transport-registry-boundary.mjs'),
    command('check-messaging-persisted-message-ingress-boundary.mjs'),
    command('check-messaging-ai-reply-pipeline-boundary.mjs'),
  ],
  operations_observability: [
    command('check-operations-operational-job-registry-boundary.mjs'),
    command('check-operations-scheduled-maintenance-boundary.mjs'),
    command('check-operations-scheduled-fleet-cron-boundary.mjs'),
  ],
  platform_shell: [
    command('check-contact-conversation-api-boundary.mjs'),
    command('check-messaging-bot-system-send-boundary.mjs'),
  ],
  telegram_channel: [
    command('check-telegram-runtime-provider-boundary.mjs'),
    command('check-telegram-driver-link-boundary.mjs'),
    command('check-messaging-telegram-binary-media-boundary.mjs'),
  ],
  whatsapp_channel: [
    command('check-whatsapp-runtime-provider-boundary.mjs'),
    command('check-messaging-whatsapp-message-boundary.mjs'),
    command('check-messaging-whatsapp-attachment-boundary.mjs'),
  ],
  work_management: [
    command('check-work-management-boundary.mjs'),
    command('check-work-management-task-view-boundary.mjs'),
    command('check-work-task-dictionary-boundary.mjs'),
  ],
}

function exactPath(repositoryRoot, relative, label) {
  assert(typeof relative === 'string' && relative.length > 0, `${label} path is missing`)
  assert(!path.isAbsolute(relative) && !relative.includes('\\') && path.posix.normalize(relative) === relative && relative !== '..' && !relative.startsWith('../'), `${label} path is not an exact repository-relative path: ${relative}`)
  const absolute = path.resolve(repositoryRoot, relative)
  assert(absolute.startsWith(`${path.resolve(repositoryRoot)}${path.sep}`), `${label} path escapes repository root: ${relative}`)
  return absolute
}

function exactReferences(index) {
  assert(index?.schema === 'yoko.crm.context-index.v1', 'context index identity mismatch')
  assert(Array.isArray(index.contexts), 'context index contexts are missing')
  assert(index.controls && typeof index.controls === 'object' && !Array.isArray(index.controls), 'context index controls are missing')
  assert(index.outputs && typeof index.outputs === 'object' && !Array.isArray(index.outputs), 'context index outputs are missing')
  const rows = [
    ...index.contexts.map((entry) => ({ category: 'context', id: entry.context, entry })),
    ...Object.keys(index.controls).sort().map((id) => ({ category: 'control', id, entry: index.controls[id] })),
    ...Object.keys(index.outputs).sort().map((id) => ({ category: 'output', id, entry: index.outputs[id] })),
  ]
  const identities = new Set()
  for (const { category, id, entry } of rows) {
    assert(typeof id === 'string' && id.length > 0, `${category} reference identity is missing`)
    assert(!identities.has(`${category}:${id}`), `duplicate ${category} reference identity: ${id}`)
    identities.add(`${category}:${id}`)
    assert(entry && typeof entry === 'object', `${category} reference is missing: ${id}`)
  }
  return rows
}

export async function verifyExactContextIndexHashes(index, repositoryRoot) {
  const counts = { contexts: 0, controls: 0, outputs: 0 }
  for (const { category, id, entry } of exactReferences(index)) {
    const bytes = await readFile(exactPath(repositoryRoot, entry.path, `${category} ${id}`))
    assert(SHA256.test(entry.sha256 ?? '') && sha256(bytes) === entry.sha256, `${category} hash mismatch: ${entry.path}`)
    counts[`${category}s`] += 1
  }
  return counts
}

export async function refreshExactContextIndexHashes(index, repositoryRoot) {
  const refreshed = structuredClone(index)
  for (const { category, id, entry } of exactReferences(refreshed)) {
    const bytes = await readFile(exactPath(repositoryRoot, entry.path, `${category} ${id}`))
    entry.sha256 = sha256(bytes)
  }
  return refreshed
}

export async function materializeContextIndexHashes(indexFile, repositoryRoot) {
  const index = JSON.parse(await readFile(indexFile, 'utf8'))
  const refreshed = await refreshExactContextIndexHashes(index, repositoryRoot)
  await writeFile(indexFile, `${JSON.stringify(stable(refreshed), null, 2)}\n`)
  return verifyExactContextIndexHashes(refreshed, repositoryRoot)
}

async function exists(repositoryRoot, relative) {
  try { await access(exactPath(repositoryRoot, relative, 'owned-path candidate')); return true } catch { return false }
}

export async function enrichContextManifests(repositoryRoot, indexFile) {
  const index = JSON.parse(await readFile(indexFile, 'utf8'))
  const manifests = await Promise.all(index.contexts.map(async (entry) => ({
    entry,
    manifest: JSON.parse(await readFile(exactPath(repositoryRoot, entry.path, `context ${entry.context}`), 'utf8')),
  })))
  const consumers = new Map(manifests.map(({ manifest }) => [manifest.context.id, []]))
  for (const { manifest } of manifests) {
    for (const dependency of manifest.allowed_dependencies) consumers.get(dependency.context).push(manifest.context.id)
  }
  for (const { entry, manifest } of manifests) {
    const id = manifest.context.id
    const slug = id.replaceAll('_', '-')
    const candidates = [
      `gravity-mvp/src/modules/${slug}`,
      `gravity-mvp/src/contracts/${slug}`,
    ]
    const ownedPaths = [...manifest.internal_surface]
    for (const candidate of candidates) if (!ownedPaths.includes(candidate) && await exists(repositoryRoot, candidate)) ownedPaths.push(candidate)
    const providerScope = id === 'messaging'
      ? 'SHARED_PROVIDER_CONTRACT'
      : ['max_channel', 'telegram_channel', 'whatsapp_channel'].includes(id)
        ? 'PROVIDER_SPECIFIC'
        : 'NOT_APPLICABLE'
    const providerSiblings = id === 'messaging'
      ? ['max_channel', 'telegram_channel', 'whatsapp_channel']
      : []
    const enriched = {
      ...manifest,
      owner: {
        accountability: `${manifest.context.name} bounded-context owner`,
        context: id,
      },
      owned_paths: minimizeOwnedPaths(ownedPaths),
      verification: {
        architecture_checks: [
          'node tools/architecture/validate-context-manifests.mjs',
          'node tools/architecture/enforce-architecture.mjs',
          'node tools/architecture/test-architecture-enforcement.mjs',
        ],
        blast_radius: {
          consumer_contexts: consumers.get(id).sort(),
          owner_context: id,
          provider_scope: providerScope,
          provider_siblings: providerSiblings,
        },
        build_checks: ['node tools/architecture/check-typescript-baseline.mjs'],
        contract_tests: [
          'node tools/architecture/validate-contract-registry.mjs',
          'node tools/architecture/check-contract-boundaries.mjs',
        ],
        module_tests: moduleTests[id],
      },
    }
    const bytes = `${JSON.stringify(stable(enriched), null, 2)}\n`
    const manifestPath = exactPath(repositoryRoot, entry.path, `context ${entry.context}`)
    if (await readFile(manifestPath, 'utf8') !== bytes) await writeFile(manifestPath, bytes)
  }
  const refreshed = await refreshExactContextIndexHashes(index, repositoryRoot)
  await writeFile(indexFile, `${JSON.stringify(stable(refreshed), null, 2)}\n`)
  await verifyExactContextIndexHashes(refreshed, repositoryRoot)
  return { contexts: manifests.length, controls: Object.keys(refreshed.controls).length, outputs: Object.keys(refreshed.outputs).length }
}

function option(argv, name) {
  const index = argv.indexOf(name)
  assert(index < 0 || (index + 1 < argv.length && !argv[index + 1].startsWith('--')), `${name} requires a value`)
  return index < 0 ? null : argv[index + 1]
}

async function main() {
  const argv = process.argv.slice(2)
  const materializeProfiles = argv.includes('--materialize')
  const materializeHashes = argv.includes('--materialize-index-hashes')
  assert(!(materializeProfiles && materializeHashes), 'choose one explicit materialization mode')
  const repositoryRoot = path.resolve(option(argv, '--root') ?? defaultRoot)
  const indexRelative = option(argv, '--index') ?? defaultIndexRelative
  const allowed = new Set(['--materialize', '--materialize-index-hashes', '--root', '--index'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    assert(allowed.has(argument), `unknown argument: ${argument}`)
    if (argument === '--root' || argument === '--index') index += 1
  }
  const indexFile = exactPath(repositoryRoot, indexRelative, 'context index')
  if (materializeProfiles) {
    const result = await enrichContextManifests(repositoryRoot, indexFile)
    process.stdout.write(`context verification profiles and exact index hashes: MATERIALIZED (${result.contexts} contexts; ${result.controls} controls; ${result.outputs} outputs)\n`)
    return
  }
  if (materializeHashes) {
    const result = await materializeContextIndexHashes(indexFile, repositoryRoot)
    process.stdout.write(`context index exact hashes: MATERIALIZED (${result.contexts} contexts; ${result.controls} controls; ${result.outputs} outputs)\n`)
    return
  }
  const index = JSON.parse(await readFile(indexFile, 'utf8'))
  const result = await verifyExactContextIndexHashes(index, repositoryRoot)
  process.stdout.write(`context index exact hashes: VERIFIED (${result.contexts} contexts; ${result.controls} controls; ${result.outputs} outputs)\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
