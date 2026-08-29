import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateContexts,
  verifyContextIndex,
  verifyCurrentDependencyTruth,
} from './enrich-context-manifests.mjs'

async function loadJson(repositoryRoot, relative) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relative), 'utf8'))
}

async function loadBundle(repositoryRoot) {
  const index = await loadJson(repositoryRoot, 'architecture/contexts/v1/context-index.json')
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
  }
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const bundle = await loadBundle(repositoryRoot)
  const shape = validateContexts(bundle)
  const hashes = await verifyContextIndex(bundle.index, repositoryRoot)
  const dependencyTruth = await verifyCurrentDependencyTruth(repositoryRoot, bundle.finalDependencySource, bundle.finalDependency)
  process.stdout.write(`${JSON.stringify({ ok: true, ...shape, ...hashes, dependencyTruth })}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
