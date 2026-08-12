#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

async function main() {
  const registryPath = path.join(root, 'architecture/contracts/v1/registry.json')
  const index = JSON.parse(await readFile(path.join(root, 'architecture/contexts/v1/context-index.json'), 'utf8'))
  const registry = JSON.parse(await readFile(registryPath, 'utf8'))
  const manifests = await Promise.all(index.contexts.map((entry) => readFile(path.join(root, entry.path), 'utf8').then(JSON.parse)))
  const consumers = new Map(manifests.map((manifest) => [manifest.context.id, []]))
  for (const manifest of manifests) {
    for (const dependency of manifest.allowed_dependencies) consumers.get(dependency.context).push(manifest.context.id)
  }
  const contextSurfaces = manifests.map((manifest) => ({
    capabilities: [...manifest.public_surface].sort(),
    commands: [...manifest.commands].sort(),
    consumer_contexts: consumers.get(manifest.context.id).sort(),
    events: [...manifest.events].sort(),
    id: `${manifest.context.id}.public.v1`,
    owner_context: manifest.context.id,
    source_roots: manifest.owned_paths.filter((ownedPath) => /\/contracts\/|\/modules\//u.test(ownedPath)).sort(),
    status: 'active',
    verification: [...manifest.verification.contract_tests].sort(),
  })).sort((left, right) => left.id.localeCompare(right.id))
  const interactions = manifests.flatMap((manifest) => manifest.allowed_dependencies.map((dependency) => ({
    id: `${manifest.context.id}>${dependency.context}.public.v1`,
    source_context: manifest.context.id,
    target_context: dependency.context,
    target_surface: dependency.surface,
    target_surface_id: `${dependency.context}.public.v1`,
  }))).sort((left, right) => left.id.localeCompare(right.id))
  const reconciled = {
    ...registry,
    coverage_policy: {
      interaction_identity: '<source_context>><target_context>.public.v1',
      manifest_dependency_coverage: 'exact',
      public_capability_coverage: 'exact',
      provider_implementation_types: 'forbidden',
      unregistered_context_surface: 'fail_closed',
    },
    context_surfaces: contextSurfaces,
    interactions,
  }
  const registryBytes = `${JSON.stringify(stable(reconciled), null, 2)}\n`
  await writeFile(registryPath, registryBytes)
  for (const [id, relative] of Object.entries({
    contract_registry: 'architecture/contracts/v1/registry.json',
    contract_registry_reconciler: 'tools/architecture/reconcile-contract-registry.mjs',
    contract_registry_validator: 'tools/architecture/validate-contract-registry.mjs',
    contract_registry_negative_tests: 'tools/architecture/test-contract-registry.mjs',
  })) {
    const bytes = id === 'contract_registry' ? registryBytes : await readFile(path.join(root, relative))
    index.controls[id] = { path: relative, sha256: sha256(bytes) }
  }
  await writeFile(path.join(root, 'architecture/contexts/v1/context-index.json'), `${JSON.stringify(stable(index), null, 2)}\n`)
  process.stdout.write(`contract registry: RECONCILED (${contextSurfaces.length} context surfaces; ${interactions.length} interactions)\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
