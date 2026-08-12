#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const forbiddenProviderImplementation = /(?:WhatsAppService|TelegramService|MaxPersonalClient|Baileys|grammy|provider_session|prisma|rawSql)/iu

export function validateContractRegistry(registry, manifests) {
  assert.equal(registry.schema, 'yoko.crm.contract-registry.v1')
  assert.equal(registry.version, 1)
  assert.equal(registry.coverage_policy?.manifest_dependency_coverage, 'exact')
  const contextIds = new Set(manifests.map((manifest) => manifest.context.id))
  const surfaces = registry.context_surfaces ?? []
  assert.equal(surfaces.length, manifests.length, 'context contract-surface coverage mismatch')
  assert.equal(new Set(surfaces.map((surface) => surface.id)).size, surfaces.length, 'duplicate context contract surface')
  for (const manifest of manifests) {
    const surface = surfaces.find((candidate) => candidate.id === `${manifest.context.id}.public.v1`)
    assert(surface, `missing context contract surface: ${manifest.context.id}`)
    assert.equal(surface.owner_context, manifest.context.id)
    assert.deepEqual(surface.capabilities, [...manifest.public_surface].sort(), `public capability drift: ${manifest.context.id}`)
    assert.deepEqual(surface.commands, [...manifest.commands].sort(), `command drift: ${manifest.context.id}`)
    assert.deepEqual(surface.events, [...manifest.events].sort(), `event drift: ${manifest.context.id}`)
    const expectedConsumers = manifests.filter((candidate) => candidate.allowed_dependencies.some((dependency) => dependency.context === manifest.context.id)).map((candidate) => candidate.context.id).sort()
    assert.deepEqual(surface.consumer_contexts, expectedConsumers, `contract consumer drift: ${manifest.context.id}`)
    assert(surface.verification.includes('node tools/architecture/validate-contract-registry.mjs'), `contract verification missing: ${manifest.context.id}`)
    assert(!forbiddenProviderImplementation.test(JSON.stringify(surface)), `provider implementation leaked into contract registry: ${manifest.context.id}`)
  }
  const interactions = registry.interactions ?? []
  const expectedInteractions = manifests.flatMap((manifest) => manifest.allowed_dependencies.map((dependency) => ({
    id: `${manifest.context.id}>${dependency.context}.public.v1`,
    source_context: manifest.context.id,
    target_context: dependency.context,
    target_surface: dependency.surface,
    target_surface_id: `${dependency.context}.public.v1`,
  }))).sort((left, right) => left.id.localeCompare(right.id))
  assert.deepEqual(interactions, expectedInteractions, 'cross-context contract interaction coverage mismatch')
  assert(interactions.every((interaction) => contextIds.has(interaction.source_context) && contextIds.has(interaction.target_context)), 'unknown interaction context')
  assert.equal(new Set(interactions.map((interaction) => interaction.id)).size, interactions.length, 'duplicate contract interaction')
  return {
    status: 'PASS',
    context_surfaces: surfaces.length,
    interactions: interactions.length,
    detailed_contracts: registry.contracts?.length ?? 0,
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const index = JSON.parse(await readFile(path.join(root, 'architecture/contexts/v1/context-index.json'), 'utf8'))
  const [registry, manifests] = await Promise.all([
    readFile(path.join(root, 'architecture/contracts/v1/registry.json'), 'utf8').then(JSON.parse),
    Promise.all(index.contexts.map((entry) => readFile(path.join(root, entry.path), 'utf8').then(JSON.parse))),
  ])
  process.stdout.write(`${JSON.stringify(validateContractRegistry(registry, manifests), null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
