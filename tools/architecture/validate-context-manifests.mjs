import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateContexts,
  verifyContextIndex,
  verifyCurrentDependencyTruth,
  verifyExecutablePathOwnership,
} from './enrich-context-manifests.mjs'
import {
  readCurrentOwnershipCoverage,
  readCurrentOwnershipDependencies,
  validateExecutablePathOwnershipProvenance,
} from './validate-executable-path-ownership.mjs'
import { inventoryTrackedSurfaces } from './v2/tracked-surface-inventory.mjs'

async function loadJson(repositoryRoot, relative) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relative), 'utf8'))
}

async function loadBundle(repositoryRoot) {
  const index = await loadJson(repositoryRoot, 'architecture/contexts/v1/context-index.json')
  const executableOwnershipDependencies = (await readCurrentOwnershipDependencies(repositoryRoot)).value
  return {
    decisions: await loadJson(repositoryRoot, 'architecture/contexts/v1/context-decisions.json'),
    inventory: await loadJson(repositoryRoot, 'architecture/evidence/v1/module-inventory.json'),
    dependencies: await loadJson(repositoryRoot, 'architecture/evidence/v1/dependency-graph.json'),
    writes: await loadJson(repositoryRoot, 'architecture/evidence/v1/write-sites.json'),
    ownership: await loadJson(repositoryRoot, 'architecture/evidence/v1/data-ownership-candidates.json'),
    index,
    manifests: await Promise.all(index.contexts.map((entry) => loadJson(repositoryRoot, entry.path))),
    foreignPlan: await loadJson(repositoryRoot, 'architecture/contexts/v1/foreign-write-migration-plan.json'),
    dependencyPlan: await loadJson(repositoryRoot, 'architecture/contexts/v1/dependency-transition-plan.json'),
    finalDependency: await loadJson(repositoryRoot, 'architecture/contexts/v1/final-dependency-current.json'),
    finalDependencySource: await loadJson(repositoryRoot, 'architecture/contexts/v1/final-dependency-source.json'),
    executableOwnershipDependencies,
  }
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const bundle = await loadBundle(repositoryRoot)
  const shape = validateContexts(bundle)
  const hashes = await verifyContextIndex(bundle.index, repositoryRoot)
  const dependencyTruth = await verifyCurrentDependencyTruth(repositoryRoot, bundle.finalDependencySource, bundle.finalDependency)
  const [registry, coverageInput] = await Promise.all([
    loadJson(repositoryRoot, 'architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json'),
    readCurrentOwnershipCoverage(repositoryRoot),
  ])
  const executableInventory = await inventoryTrackedSurfaces(repositoryRoot, { registry })
  const executableOwnership = verifyExecutablePathOwnership(bundle.manifests, coverageInput.value, executableInventory)
  await validateExecutablePathOwnershipProvenance(repositoryRoot, coverageInput.value, executableInventory, bundle.manifests)
  process.stdout.write(`${JSON.stringify({ ok: true, ...shape, ...hashes, dependencyTruth, executableOwnership: { ...executableOwnership, records: undefined } })}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
