#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sourcePath = 'architecture/contexts/v1/final-dependency-source.json'
const outputPath = 'architecture/contexts/v1/final-dependency-current.json'
const digest = (value) => createHash('sha256').update(value).digest('hex')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export function materializeFinalDependencyArtifact(sourceBytes) {
  const source = JSON.parse(sourceBytes)
  assert(source.schema === 'yoko.crm.accepted-dependency-source.v1', 'accepted dependency source identity mismatch')
  assert(source.derivation?.kind === 'architecture-enforcement-observed-cross-context-imports', 'accepted dependency source must be derived from architecture enforcement')
  assert(typeof source.observed?.cross_context_imports_sha256 === 'string' && /^[0-9a-f]{64}$/.test(source.observed.cross_context_imports_sha256), 'accepted dependency source observation digest missing')
  assert(Number.isInteger(source.observed?.cross_context_imports) && source.observed.cross_context_imports >= 0, 'accepted dependency source import count invalid')
  assert(Number.isInteger(source.relationship_projection?.count) && source.relationship_projection.count > 0 && typeof source.relationship_projection.sha256 === 'string' && /^[0-9a-f]{64}$/.test(source.relationship_projection.sha256), 'accepted dependency relationship projection missing')
  assert(Array.isArray(source.public_surface_migrations) && source.public_surface_migrations.length === 0, 'accepted source retains public-surface migration debt')
  return {
    generated_from: sourcePath,
    source_sha256: digest(sourceBytes),
    schema: 'yoko.crm.final-dependency-current.v1',
    summary: {
      architecture_findings: source.observed.architecture_findings,
      cross_context_imports: source.observed.cross_context_imports,
      forbidden_dependencies: source.observed.architecture_findings,
      public_surface_migrations: 0,
      relationships: source.relationship_projection.count,
    },
    version: 1,
  }
}

async function main() {
  const sourceBytes = await readFile(path.join(root, sourcePath), 'utf8')
  const artifact = materializeFinalDependencyArtifact(sourceBytes)
  await writeFile(path.join(root, outputPath), `${JSON.stringify(artifact, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ ok: true, output: outputPath, ...artifact.summary })}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
