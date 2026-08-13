#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const SOURCE_PATH = 'architecture/contexts/v1/final-dependency-source.json'
const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

export function deriveFinalDependencySource(scan) {
  if (!scan || !Array.isArray(scan.observed_cross_context_imports) || !Array.isArray(scan.findings)) throw new Error('architecture scan is incomplete')
  const groups = new Map()
  for (const edge of scan.observed_cross_context_imports) {
    if (!edge.source_context || !edge.target_context || edge.source_context === edge.target_context) throw new Error('invalid observed cross-context dependency')
    const key = `${edge.source_context}>${edge.target_context}`
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  const relationships = [...groups.entries()]
    .map(([key, import_count]) => {
      const [source_context, target_context] = key.split('>')
      return { import_count, source_context, target_context }
    })
    .sort((left, right) => left.source_context.localeCompare(right.source_context) || left.target_context.localeCompare(right.target_context))
  return {
    derivation: {
      kind: 'architecture-enforcement-observed-cross-context-imports',
      policy_sha256: digest(scan.policy),
      policy_path: 'architecture/enforcement/v1/policy.json',
    },
    observed: {
      architecture_findings: scan.findings.length,
      cross_context_imports: scan.observed_cross_context_imports.length,
      cross_context_imports_sha256: digest(scan.observed_cross_context_imports),
      scanned_files: scan.scanned_files,
    },
    public_surface_migrations: [],
    relationship_projection: {
      count: relationships.length,
      sha256: digest(relationships),
    },
    schema: 'yoko.crm.accepted-dependency-source.v1',
    version: 1,
  }
}

export async function deriveCurrentDependencySource(repositoryRoot = root) {
  return deriveFinalDependencySource(await scanArchitecture(repositoryRoot))
}

async function main() {
  const source = await deriveCurrentDependencySource(root)
  if (process.argv.includes('--write')) await writeFile(path.join(root, SOURCE_PATH), `${JSON.stringify(stable(source), null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ ok: true, output: SOURCE_PATH, ...source.observed, relationships: source.relationship_projection.count })}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1 })
}
