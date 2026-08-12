#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const indexPath = path.join(root, 'architecture/contexts/v1/context-index.json')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}
const command = (checker) => `node tools/architecture/${checker}`
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

async function exists(relative) {
  try { await access(path.join(root, relative)); return true } catch { return false }
}

async function main() {
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  const manifests = await Promise.all(index.contexts.map(async (entry) => ({
    entry,
    manifest: JSON.parse(await readFile(path.join(root, entry.path), 'utf8')),
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
    for (const candidate of candidates) if (!ownedPaths.includes(candidate) && await exists(candidate)) ownedPaths.push(candidate)
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
      owned_paths: ownedPaths.sort(),
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
    await writeFile(path.join(root, entry.path), bytes)
    entry.sha256 = sha256(bytes)
  }
  for (const [id, relative] of Object.entries({
    module_manifest_schema: 'architecture/contexts/v1/module-manifest.schema.json',
    verification_profile_enricher: 'tools/architecture/enrich-context-manifests.mjs',
  })) {
    index.controls[id] = { path: relative, sha256: sha256(await readFile(path.join(root, relative))) }
  }
  await writeFile(indexPath, `${JSON.stringify(stable(index), null, 2)}\n`)
  process.stdout.write(`context verification profiles: UPDATED (${manifests.length}/${manifests.length})\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
