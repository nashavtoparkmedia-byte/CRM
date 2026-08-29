#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { gitChangedPaths } from './git-change-set.mjs'

const ARCHITECTURE_CONTROL_PLANE = 'architecture_control_plane'

export function compileBlastRadiusMetadata(moduleRules, manifests) {
  const contextIds = new Set(manifests.map((manifest) => manifest.context.id))
  const technicalToContext = new Map()
  for (const manifest of manifests) {
    for (const technical of manifest.technical_modules ?? []) technicalToContext.set(technical, manifest.context.id)
  }
  return {
    contextIds,
    manifests,
    rules: moduleRules.modules.map((rule) => ({
      ...rule,
      context_id: technicalToContext.get(rule.id) ?? rule.context,
      regex: new RegExp(rule.match),
    })),
  }
}

export function contextForChangedPath(relative, metadata) {
  const normalized = relative.replaceAll('\\', '/')
  if (/^(?:architecture|tools\/architecture|\.github\/workflows\/architecture-enforcement\.yml)/u.test(normalized)) {
    return ARCHITECTURE_CONTROL_PLANE
  }
  const module = /^gravity-mvp\/src\/modules\/([^/]+)\//u.exec(normalized)?.[1]?.replaceAll('-', '_')
  if (module && metadata.contextIds.has(module)) return module
  const contract = /^gravity-mvp\/src\/contracts\/([^/]+)\//u.exec(normalized)?.[1]?.replaceAll('-', '_')
  if (contract && metadata.contextIds.has(contract)) return contract
  return metadata.rules.find((rule) => rule.regex.test(normalized))?.context_id ?? null
}

export function computeBlastRadius(changedPaths, metadata) {
  const productionRoots = /^(?:gravity-mvp\/src|tg-bot\/src|avito-worker\/src|yandex-fleet-scraper\/src)\//u
  const pathMappings = changedPaths.map((changedPath) => ({
    path: changedPath,
    context: contextForChangedPath(changedPath, metadata),
  }))
  const unclassified = pathMappings.filter((mapping) => (
    !mapping.context && productionRoots.test(mapping.path)
  ))
  assert.deepEqual(unclassified, [], 'changed production path is outside deterministic blast-radius ownership')

  const owners = new Set(pathMappings.map((mapping) => mapping.context).filter((context) => (
    context && context !== ARCHITECTURE_CONTROL_PLANE
  )))
  const consumers = new Set()
  for (const manifest of metadata.manifests) {
    if ((manifest.allowed_dependencies ?? []).some((dependency) => owners.has(dependency.context))) {
      consumers.add(manifest.context.id)
    }
  }
  const affected = new Set([...owners, ...consumers])
  const controlPlaneChanged = pathMappings.some((mapping) => mapping.context === ARCHITECTURE_CONTROL_PLANE)
  if (controlPlaneChanged) metadata.contextIds.forEach((context) => affected.add(context))

  const affectedManifests = metadata.manifests.filter((manifest) => affected.has(manifest.context.id))
  const requiredChecks = [...new Set(affectedManifests.flatMap((manifest) => [
    ...manifest.verification.architecture_checks,
    ...manifest.verification.module_tests,
    ...manifest.verification.contract_tests,
    ...manifest.verification.build_checks,
  ]))]
  return {
    schema: 'yoko.crm.blast-radius.v1',
    changed_paths: pathMappings,
    owner_contexts: [...owners].sort(),
    consumer_contexts: [...consumers].sort(),
    affected_contexts: [...affected].sort(),
    required_checks: requiredChecks,
    unclassified_production_paths: 0,
  }
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const readJson = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'))
  const index = readJson('architecture/contexts/v1/context-index.json')
  const manifests = index.contexts.map((entry) => readJson(entry.path))
  const metadata = compileBlastRadiusMetadata(
    readJson('architecture/evidence/v1/module-rules.json'),
    manifests,
  )
  const explicit = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))
  const result = computeBlastRadius(explicit.length > 0 ? explicit : gitChangedPaths(root), metadata)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  }
}
