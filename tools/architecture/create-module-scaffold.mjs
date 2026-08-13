#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractImports, extractNonliteralModuleLoads } from './enforce-architecture.mjs'
import { analyzePrismaWriteSites } from './v2/write-analyzer.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const templateRoot = path.join(repositoryRoot, 'architecture/contexts/v1/module-scaffold')
const requiredManifestFields = [
  'schema', 'version', 'context', 'owner', 'responsibility', 'technical_modules',
  'owned_paths', 'verification', 'owned_data', 'public_surface', 'internal_surface',
  'allowed_dependencies', 'forbidden_dependencies', 'provider_relationships',
  'credential_relationships', 'commands', 'events', 'foreign_write_migration_plans',
  'protected', 'compatibility_strategy', 'evidence',
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export function validateModuleSource(relativePath, source) {
  if (!/\/public(?:\/|$)/.test(relativePath)) return
  for (const loaded of extractNonliteralModuleLoads(source)) throw new Error(`public facade uses nonliteral ${loaded.kind}: ${relativePath}`)
  for (const imported of extractImports(source)) {
    const target = imported.specifier.startsWith('.')
      ? path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), imported.specifier))
      : imported.specifier
    if (target.split('/').includes('internal')) throw new Error(`public facade imports internal code: ${relativePath}`)
  }
  const analysis = analyzePrismaWriteSites(source, { fileName: relativePath, knownModels: [], relationFields: [] })
  if (analysis.diagnostics.length > 0 || analysis.sites.length > 0) throw new Error(`public facade performs persistence write: ${relativePath}`)
}

function commandPaths(manifest) {
  return ['module_tests', 'contract_tests', 'architecture_checks', 'build_checks']
    .flatMap((key) => manifest.verification[key])
    .map((entry) => entry.replace(/^node /, ''))
}

// This is intentionally equivalent to the repository module-manifest schema's
// shape, plus the candidate-only guarantees that the live bundle validator
// cannot apply until a context decision has been made.
export function validateModuleManifestCandidate(manifest, schema) {
  assert(schema?.properties && Array.isArray(schema.required), 'module-manifest schema unavailable')
  assert(JSON.stringify([...schema.required].sort()) === JSON.stringify([...requiredManifestFields].sort()), 'module-manifest schema required fields drifted; update scaffold validator')
  assert(JSON.stringify(Object.keys(manifest).sort()) === JSON.stringify(Object.keys(schema.properties).sort()), 'candidate manifest must contain exactly the real module-manifest fields')
  assert(manifest.schema === 'yoko.crm.module-manifest.v1' && manifest.version === 1, 'candidate manifest identity mismatch')
  assert(typeof manifest.context?.id === 'string' && /^[a-z][a-z0-9_]*$/.test(manifest.context.id) && typeof manifest.context.name === 'string' && /^[A-Z][A-Za-z0-9]*$/.test(manifest.context.name), 'candidate context identity invalid')
  assert(manifest.owner?.context === manifest.context.id && typeof manifest.owner.accountability === 'string' && manifest.owner.accountability.length > 0, 'candidate owner invalid')
  assert(typeof manifest.responsibility === 'string' && manifest.responsibility.length > 0, 'candidate responsibility missing')
  for (const field of ['technical_modules', 'owned_paths', 'owned_data', 'public_surface', 'internal_surface', 'allowed_dependencies', 'forbidden_dependencies', 'provider_relationships', 'commands', 'events', 'foreign_write_migration_plans']) assert(Array.isArray(manifest[field]), `candidate ${field} must be an array`)
  assert(manifest.technical_modules.length === 1 && manifest.technical_modules[0] === `candidate:${manifest.context.id}`, 'candidate technical-module declaration invalid')
  assert(manifest.owned_paths.length === 2 && new Set(manifest.owned_paths).size === 2 && manifest.owned_paths.every((item) => typeof item === 'string' && !item.startsWith('/') && !item.split('/').includes('..')), 'candidate owned paths invalid')
  assert(manifest.owned_data.length === 1 && manifest.owned_data[0]?.model === `${manifest.context.name}Record`, 'candidate data ownership invalid')
  assert(manifest.public_surface.length === 1 && manifest.public_surface[0] === `${manifest.context.name}.v1`, 'candidate public surface invalid')
  assert(manifest.internal_surface.length === 1 && manifest.internal_surface[0].startsWith(`gravity-mvp/src/modules/${manifest.context.id.replaceAll('_', '-')}/internal`), 'candidate internal surface invalid')
  assert(manifest.forbidden_dependencies.includes('directForeignPrismaWrites') && manifest.forbidden_dependencies.includes('credentialValuesInContracts'), 'candidate prohibitions incomplete')
  assert(manifest.provider_relationships.length === 1 && manifest.provider_relationships[0]?.provider === 'NONE' && Array.isArray(manifest.provider_relationships[0].allowed_imports) && manifest.provider_relationships[0].allowed_imports.length === 0, 'candidate provider relationship invalid')
  assert(Array.isArray(manifest.credential_relationships?.environment_names) && manifest.credential_relationships.environment_names.length === 0 && typeof manifest.credential_relationships.policy === 'string' && manifest.credential_relationships.policy.includes('Values stay inside'), 'candidate credential relationship invalid')
  assert(manifest.protected === true && typeof manifest.compatibility_strategy === 'string' && manifest.compatibility_strategy.length > 0, 'candidate compatibility protection invalid')
  assert(manifest.evidence?.candidate_only === true && manifest.evidence?.integration_status === 'CANDIDATE_NOT_IN_CONTEXT_INDEX', 'candidate evidence must remain non-live')
  const verification = manifest.verification
  assert(verification && ['module_tests', 'contract_tests', 'architecture_checks', 'build_checks'].every((field) => Array.isArray(verification[field]) && verification[field].length > 0), 'candidate verification profile incomplete')
  assert(commandPaths(manifest).every((entry) => /^tools\/architecture\/[a-z0-9./-]+\.mjs$/.test(entry)), 'candidate verification command invalid')
  assert(verification.architecture_checks.includes('node tools/architecture/validate-context-manifests.mjs') && verification.architecture_checks.includes('node tools/architecture/enforce-architecture.mjs'), 'candidate architecture controls missing')
  assert(verification.contract_tests.includes(`node tools/architecture/generated/${manifest.context.id.replaceAll('_', '-')}-contract-test.mjs`), 'candidate contract entrypoint missing')
  assert(verification.build_checks.includes('node tools/architecture/check-typescript-baseline.mjs'), 'candidate build control missing')
  assert(verification.blast_radius?.owner_context === manifest.context.id && JSON.stringify(verification.blast_radius.consumer_contexts) === '[]' && verification.blast_radius.provider_scope === 'NOT_APPLICABLE' && JSON.stringify(verification.blast_radius.provider_siblings) === '[]', 'candidate blast radius invalid')
  return manifest
}

function architectureCheckSource(slug) {
  return `#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const toolRoot = path.resolve(process.env.YOKO_ARCHITECTURE_TOOL_ROOT ?? root)
const [{ extractEnvironmentAccess, extractImports, extractNonliteralModuleLoads }, { analyzePrismaWriteSites }] = await Promise.all([
  import(pathToFileURL(path.join(toolRoot, 'tools/architecture/enforce-architecture.mjs')).href),
  import(pathToFileURL(path.join(toolRoot, 'tools/architecture/v2/write-analyzer.mjs')).href),
])
const manifestPath = 'architecture/contexts/v1/manifests/${slug.replaceAll('-', '_')}.json'
const moduleRoot = 'gravity-mvp/src/modules/${slug}'
const assert = (value, message) => { if (!value) throw new Error(message) }
const read = (relative) => readFile(path.join(root, relative), 'utf8')
const normalizeModel = (value) => value.replaceAll('_', '').toLowerCase()
const contextSlug = (value) => value.replaceAll('_', '-')
const codeExtension = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const knownProvider = (specifier) => [
  'openai', '@anthropic-ai/sdk', 'whatsapp-web.js', 'telegraf',
  'node-telegram-bot-api', 'telegram', '@whiskeysockets/baileys',
  'modesl', 'bullmq', 'ioredis', 'max-bot-api',
].some((prefix) => specifier === prefix || specifier.startsWith(prefix + '/'))
  || specifier.startsWith('@aws-sdk/') || specifier.startsWith('@maxhub/')
function moduleImportTarget(relative, specifier) {
  let target = null
  if (specifier.startsWith('@/modules/')) target = 'gravity-mvp/src/modules/' + specifier.slice('@/modules/'.length)
  else if (specifier.startsWith('gravity-mvp/src/modules/')) target = specifier
  else if (specifier.startsWith('.')) target = path.posix.join(path.posix.dirname(relative), specifier)
  if (!target) return null
  const normalized = path.posix.normalize(target)
  const match = normalized.match(/^gravity-mvp\\/src\\/modules\\/([^/]+)(?:\\/(.*))?$/)
  return match ? { context: match[1], surface: match[2] ?? '', target: normalized } : null
}
async function sources(relative) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const target = path.posix.join(relative, entry.name)
    if (entry.isDirectory()) files.push(...await sources(target))
    else if (entry.isFile() && codeExtension.test(target)) files.push(target)
  }
  return files
}
const manifest = JSON.parse(await read(manifestPath))
assert(manifest.schema === 'yoko.crm.module-manifest.v1' && manifest.version === 1, 'module manifest identity mismatch')
assert(manifest.evidence?.integration_status === 'CANDIDATE_NOT_IN_CONTEXT_INDEX', 'candidate integration status changed')
assert(manifest.forbidden_dependencies?.includes('directForeignPrismaWrites'), 'foreign-write prohibition missing')
assert(manifest.provider_relationships?.every((item) => item.provider === 'NONE'), 'candidate provider authorization must be approved before use')
const declaredEnvironment = new Set(manifest.credential_relationships?.environment_names ?? [])
const allowedProviderImports = new Set((manifest.provider_relationships ?? []).flatMap((item) => item.allowed_imports ?? []))
const allowedContextSlugs = new Set((manifest.allowed_dependencies ?? []).map((item) => contextSlug(item.context)))
const ownedModels = new Set((manifest.owned_data ?? []).map((item) => item.model ? normalizeModel(item.model) : '').filter(Boolean))
for (const relative of await sources(moduleRoot)) {
  const source = await read(relative)
  const imports = extractImports(source)
  const nonliteralLoads = extractNonliteralModuleLoads(source)
  const writeAnalysis = analyzePrismaWriteSites(source, {
    fileName: relative,
    knownModels: [...ownedModels],
    relationFields: [],
  })
  assert(writeAnalysis.diagnostics.length === 0, 'authoritative write parser finding: ' + relative)
  assert(nonliteralLoads.length === 0, 'nonliteral module load is not authorized by candidate: ' + relative)
  if (relative.includes('/public/')) {
    for (const imported of imports) {
      const target = moduleImportTarget(relative, imported.specifier)
      const privateInternal = target?.context === '${slug}' && /^internal(?:\\/|$)/.test(target.surface)
      assert(!privateInternal, 'public facade imports private internal code: ' + relative)
    }
    assert(writeAnalysis.sites.length === 0, 'public facade performs persistence write: ' + relative)
  }
  for (const imported of imports) {
    if (knownProvider(imported.specifier)) assert(allowedProviderImports.has(imported.specifier), 'provider import is not authorized by candidate relationship: ' + relative)
    const foreignModule = moduleImportTarget(relative, imported.specifier)
    if (foreignModule && foreignModule.context !== '${slug}') {
      assert(allowedContextSlugs.has(foreignModule.context), 'foreign module dependency is not declared by candidate: ' + relative)
      assert(/^public\\/v[1-9][0-9]*(?:\\/|$)/.test(foreignModule.surface), 'foreign module dependency must use a versioned public surface: ' + relative)
    }
  }
  for (const environment of extractEnvironmentAccess(source)) assert(declaredEnvironment.has(environment.name), 'credential environment is not declared by candidate relationship: ' + environment.name)
  for (const site of writeAnalysis.sites) {
    assert(!site.ambiguous, 'unresolved persistence write is not authorized by candidate: ' + relative)
    const targets = [...new Set([site.model, ...(site.candidate_models ?? [])].filter(Boolean).map(normalizeModel))]
    assert(targets.length > 0 && targets.every((target) => ownedModels.has(target)), 'foreign persistence write is not owned by candidate: ' + (targets.join(',') || '<dynamic>'))
  }
}
process.stdout.write(JSON.stringify({ ok: true, candidate: manifest.context.id, status: manifest.evidence.integration_status }) + '\\n')
`
}

function moduleTestSource(slug) {
  return `#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
const source = await readFile(path.join(process.cwd(), 'gravity-mvp/src/modules/${slug}/public/v1/index.ts'), 'utf8')
if (/(?:import|export)[\\s\\S]*?['\"][^'\"]*\\/internal\\//.test(source)) throw new Error('public facade imports internal code')
if (/\\b(?:prisma|tx|transaction)\\.[A-Za-z_$][\\w$]*\\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\\s*\\(/.test(source)) throw new Error('public facade performs persistence write')
process.stdout.write('module public boundary: PASS\\n')
`
}

function contractTestSource(slug, name) {
  return `#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
const source = await readFile(path.join(process.cwd(), 'gravity-mvp/src/contracts/${slug}/v1/index.ts'), 'utf8')
if (!source.includes('${name}OperationV1')) throw new Error('versioned operation contract missing')
if (/(?:prisma|next\\/|@\\/lib|@\\/app|\\/internal\\/)/i.test(source)) throw new Error('contract leaks implementation detail')
process.stdout.write('module contract boundary: PASS\\n')
`
}

function buildCheckSource(slug) {
  return `#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
const root = process.cwd()
const manifest = JSON.parse(await readFile(path.join(root, 'architecture/contexts/v1/manifests/${slug.replaceAll('-', '_')}.json'), 'utf8'))
for (const relative of ['gravity-mvp/src/modules/${slug}/public/v1/index.ts', 'gravity-mvp/src/modules/${slug}/internal/owner-operation.ts', 'gravity-mvp/src/contracts/${slug}/v1/index.ts']) await access(path.join(root, relative))
for (const command of ['module_tests', 'contract_tests', 'architecture_checks', 'build_checks'].flatMap((key) => manifest.verification[key]).filter((entry) => entry.includes('/generated/'))) await access(path.join(root, command.replace(/^node /, '')))
process.stdout.write('module scaffold build entrypoints: PASS\\n')
`
}

export async function createModuleScaffold(destinationRoot, { id, name }) {
  assert(/^[a-z][a-z0-9_]*$/.test(id), 'module id must be lowercase snake_case')
  assert(/^[A-Z][A-Za-z0-9]*$/.test(name), 'module name must be PascalCase')
  const slug = id.replaceAll('_', '-')
  const replace = (value) => value
    .replaceAll('__MODULE_ID__', id)
    .replaceAll('__MODULE_NAME__', name)
    .replaceAll('__MODULE_SLUG__', slug)
  const readTemplate = (file) => readFile(path.join(templateRoot, file), 'utf8')
  const [manifestTemplate, integrationTemplate, instructionsTemplate, publicTemplate, internalTemplate, schema] = await Promise.all([
    readTemplate('manifest.json.template'), readTemplate('candidate-integration.json.template'), readTemplate('candidate-integration.md.template'),
    readTemplate('public-v1-index.ts.template'), readTemplate('internal-owner-operation.ts.template'),
    readFile(path.join(repositoryRoot, 'architecture/contexts/v1/module-manifest.schema.json'), 'utf8'),
  ])
  const moduleRoot = path.join(destinationRoot, 'gravity-mvp/src/modules', slug)
  const contractRoot = path.join(destinationRoot, 'gravity-mvp/src/contracts', slug, 'v1')
  const generatedRoot = path.join(destinationRoot, 'tools/architecture/generated')
  const candidateRoot = path.join(destinationRoot, 'architecture/contexts/v1/candidates')
  await Promise.all([
    mkdir(path.join(moduleRoot, 'public/v1'), { recursive: true }), mkdir(path.join(moduleRoot, 'internal'), { recursive: true }),
    mkdir(contractRoot, { recursive: true }), mkdir(path.join(destinationRoot, 'architecture/contexts/v1/manifests'), { recursive: true }),
    mkdir(generatedRoot, { recursive: true }), mkdir(candidateRoot, { recursive: true }),
  ])
  const publicSource = replace(publicTemplate)
  validateModuleSource(`gravity-mvp/src/modules/${slug}/public/v1/index.ts`, publicSource)
  const manifest = JSON.parse(replace(manifestTemplate))
  validateModuleManifestCandidate(manifest, JSON.parse(schema))
  await Promise.all([
    writeFile(path.join(moduleRoot, 'public/v1/index.ts'), publicSource),
    writeFile(path.join(moduleRoot, 'internal/owner-operation.ts'), replace(internalTemplate)),
    writeFile(path.join(contractRoot, 'index.ts'), `export type { ${name}OperationV1 } from '../../../modules/${slug}/public/v1'\n`),
    writeFile(path.join(destinationRoot, 'architecture/contexts/v1/manifests', `${id}.json`), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(candidateRoot, `${id}.integration.json`), `${JSON.stringify(JSON.parse(replace(integrationTemplate)), null, 2)}\n`),
    writeFile(path.join(candidateRoot, `${id}.integration.md`), replace(instructionsTemplate)),
    writeFile(path.join(generatedRoot, `${slug}-module-test.mjs`), moduleTestSource(slug)),
    writeFile(path.join(generatedRoot, `${slug}-contract-test.mjs`), contractTestSource(slug, name)),
    writeFile(path.join(generatedRoot, `${slug}-architecture-check.mjs`), architectureCheckSource(slug)),
    writeFile(path.join(generatedRoot, `${slug}-build-check.mjs`), buildCheckSource(slug)),
  ])
  return { moduleRoot, id, slug, manifestPath: `architecture/contexts/v1/manifests/${id}.json`, integrationPath: `architecture/contexts/v1/candidates/${id}.integration.json`, entrypoints: commandPaths(manifest) }
}

async function main() {
  const [destinationRoot, id, name] = process.argv.slice(2)
  assert(destinationRoot && id && name, 'usage: create-module-scaffold.mjs <destination-root> <id> <Name>')
  process.stdout.write(`${JSON.stringify(await createModuleScaffold(path.resolve(destinationRoot), { id, name }))}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
