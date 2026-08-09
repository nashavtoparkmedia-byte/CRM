#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const WRITE_METHODS = new Set([
    'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany',
    'upsert', 'delete', 'deleteMany',
])

function stable(value) {
    if (Array.isArray(value)) return value.map(stable)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

function digest(value) {
    return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value))).digest('hex')
}

function lineAt(text, index) {
    let line = 1
    for (let cursor = 0; cursor < index; cursor += 1) if (text.charCodeAt(cursor) === 10) line += 1
    return line
}

function executablePositions(text) {
    const positions = new Uint8Array(text.length)
    let state = 'code'
    let escaped = false
    const templateExpressionDepths = []
    for (let index = 0; index < text.length; index += 1) {
        const current = text[index]
        const next = text[index + 1]
        if (state === 'line') {
            if (current === '\n') state = 'code'
            continue
        }
        if (state === 'block') {
            if (current === '*' && next === '/') {
                index += 1
                state = 'code'
            }
            continue
        }
        if (state === 'single' || state === 'double') {
            if (escaped) escaped = false
            else if (current === '\\') escaped = true
            else if ((state === 'single' && current === "'") || (state === 'double' && current === '"')) state = 'code'
            continue
        }
        if (state === 'template') {
            if (escaped) escaped = false
            else if (current === '\\') escaped = true
            else if (current === '`') state = 'code'
            else if (current === '$' && next === '{') {
                templateExpressionDepths.push(1)
                index += 1
                state = 'code'
            }
            continue
        }

        positions[index] = 1
        if (current === '/' && next === '/') {
            positions[index + 1] = 1
            index += 1
            state = 'line'
        } else if (current === '/' && next === '*') {
            positions[index + 1] = 1
            index += 1
            state = 'block'
        } else if (current === "'") state = 'single'
        else if (current === '"') state = 'double'
        else if (current === '`') state = 'template'
        else if (templateExpressionDepths.length > 0 && current === '{') {
            templateExpressionDepths[templateExpressionDepths.length - 1] += 1
        } else if (templateExpressionDepths.length > 0 && current === '}') {
            templateExpressionDepths[templateExpressionDepths.length - 1] -= 1
            if (templateExpressionDepths.at(-1) === 0) {
                templateExpressionDepths.pop()
                state = 'template'
            }
        }
    }
    return positions
}

export function extractImports(text) {
    const found = []
    const executable = executablePositions(text)
    const patterns = [
        { kind: 'static', regex: /\bimport\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g },
        { kind: 'export', regex: /\bexport\s+[^'";]*?\s+from\s+['"]([^'"]+)['"]/g },
        { kind: 'require', regex: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
        { kind: 'dynamic', regex: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
    ]
    const seen = new Set()
    for (const { kind, regex } of patterns) {
        for (const match of text.matchAll(regex)) {
            if (!executable[match.index]) continue
            const key = `${match.index}:${match[1]}`
            if (seen.has(key)) continue
            seen.add(key)
            found.push({ kind, specifier: match[1], index: match.index })
        }
    }
    return found.sort((left, right) => left.index - right.index || left.specifier.localeCompare(right.specifier))
}

export function extractEnvironmentAccess(text) {
    const records = []
    const executable = executablePositions(text)
    const patterns = [
        /process\.env\.([A-Z][A-Z0-9_]*)/g,
        /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
        /\benv\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
    ]
    const seen = new Set()
    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            if (!executable[match.index]) continue
            const key = `${match.index}:${match[1]}`
            if (seen.has(key)) continue
            seen.add(key)
            records.push({ index: match.index, name: match[1] })
        }
    }
    return records
}

export function extractPrismaWrites(text) {
    const executable = executablePositions(text)
    const records = []
    const modelPattern = /\b(prisma|prismaClient|tx|transaction|db)\b(?:\s+as\s+any)?\s*\)?\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(createManyAndReturn|createMany|create|updateMany|update|upsert|deleteMany|delete)\s*\(/g
    for (const match of text.matchAll(modelPattern)) {
        if (!executable[match.index]) continue
        if (!WRITE_METHODS.has(match[3])) continue
        records.push({ index: match.index, kind: 'model', model: match[2], method: match[3] })
    }
    const rawPattern = /\b(prisma|prismaClient|tx|transaction|db)\b(?:\s+as\s+any)?\s*\)?\s*\.\s*(\$executeRaw|\$executeRawUnsafe)\b/g
    for (const match of text.matchAll(rawPattern)) {
        if (!executable[match.index]) continue
        const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 2400)
        const firstTick = tail.indexOf('`')
        const closingTick = firstTick >= 0 ? tail.indexOf('`', firstTick + 1) : -1
        const snippet = firstTick >= 0 && closingTick > firstTick
            ? tail.slice(firstTick + 1, closingTick)
            : tail.slice(0, 900)
        const tables = [...snippet.matchAll(/(?:UPDATE|INTO|DELETE\s+FROM|TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi)]
            .map((item) => item[1])
        records.push({ index: match.index, kind: 'raw', method: match[2], tables: [...new Set(tables)].sort() })
    }
    return records.sort((left, right) => left.index - right.index)
}

async function exists(candidate) {
    try {
        await access(candidate)
        return true
    } catch {
        return false
    }
}

async function walk(directory, excludes, result = []) {
    if (!(await exists(directory))) return result
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
        if (entry.name === '.git' || excludes.has(entry.name)) continue
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) await walk(absolute, excludes, result)
        else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name))) result.push(absolute)
    }
    return result
}

async function loadJson(root, relative) {
    return JSON.parse(await readFile(path.join(root, relative), 'utf8'))
}

function slugContext(slug) {
    const aliases = {
        'work-management': 'work_management',
        'platform-shell': 'platform_shell',
        calling: 'calling',
    }
    return aliases[slug] ?? slug.replaceAll('-', '_')
}

function applyManifestAmendments(manifests, amendments) {
    const byContext = new Map(manifests.map((manifest) => [manifest.context.id, structuredClone(manifest)]))
    for (const bundle of amendments) {
        for (const amendment of bundle.amendments) {
            const manifest = byContext.get(amendment.context)
            if (!manifest) continue
            const additions = [
                ['add_public_surface', 'public_surface'],
                ['add_internal_surface', 'internal_surface'],
                ['add_events', 'events'],
                ['add_commands', 'commands'],
            ]
            for (const [source, target] of additions) {
                if (amendment[source]) manifest[target] = [...new Set([...(manifest[target] ?? []), ...amendment[source]])]
            }
            manifest.owned_infrastructure_state = [
                ...new Set([...(manifest.owned_infrastructure_state ?? []), ...(amendment.add_owned_infrastructure_state ?? [])]),
            ]
            for (const dependency of amendment.add_allowed_dependencies ?? []) {
                if (!manifest.allowed_dependencies.some((item) => item.context === dependency.context && item.surface === dependency.surface)) manifest.allowed_dependencies.push(dependency)
            }
        }
    }
    return [...byContext.values()]
}

function dependencyCycles(manifests) {
    const adjacency = new Map(manifests.map((manifest) => [
        manifest.context.id,
        manifest.allowed_dependencies.map((dependency) => dependency.context),
    ]))
    const visiting = new Set()
    const visited = new Set()
    const cycles = []
    function visit(node, trail) {
        if (visiting.has(node)) {
            cycles.push([...trail.slice(trail.indexOf(node)), node])
            return
        }
        if (visited.has(node)) return
        visiting.add(node)
        for (const target of adjacency.get(node) ?? []) visit(target, [...trail, target])
        visiting.delete(node)
        visited.add(node)
    }
    for (const node of adjacency.keys()) visit(node, [node])
    return cycles
}

export function validateManifestPolicy(manifests, amendments) {
    const findings = []
    const contextIds = new Set(manifests.map((manifest) => manifest.context.id))
    for (const manifest of manifests) {
        for (const value of [...manifest.public_surface, ...manifest.events, ...manifest.commands]) {
            if (!/\.v[1-9][0-9]*$/.test(value)) {
                findings.push({ rule: 'manifest_inconsistency', file: 'architecture/contexts/v1', subject: `${manifest.context.id}:unversioned:${value}` })
            }
        }
        for (const dependency of manifest.allowed_dependencies) {
            if (!contextIds.has(dependency.context) || dependency.context === manifest.context.id) {
                findings.push({ rule: 'manifest_inconsistency', file: 'architecture/contexts/v1', subject: `${manifest.context.id}:dependency:${dependency.context}` })
            }
        }
    }
    for (const bundle of amendments) {
        for (const amendment of bundle.amendments) {
            if (!contextIds.has(amendment.context)) {
                findings.push({ rule: 'manifest_inconsistency', file: 'architecture/events/v1/module-manifest-amendments.json', subject: `unknown-context:${amendment.context}` })
            }
        }
    }
    for (const cycle of dependencyCycles(manifests)) {
        findings.push({ rule: 'dependency_graph_cycle', file: 'architecture/contexts/v1', subject: cycle.join('>') })
    }
    return findings
}

function contextState(policy, moduleRules, manifests, amendments) {
    const effectiveManifests = applyManifestAmendments(manifests, amendments)
    const moduleContext = new Map()
    for (const manifest of effectiveManifests) {
        for (const module of manifest.technical_modules) moduleContext.set(module, manifest.context.id)
    }
    const compiledRules = moduleRules.modules.map((rule) => ({ ...rule, regex: new RegExp(rule.match) }))
    const manifestsByContext = new Map(effectiveManifests.map((manifest) => [manifest.context.id, manifest]))

    function classifyFile(relative) {
        const moduleMatch = relative.match(/^gravity-mvp\/src\/modules\/([^/]+)\//)
        if (moduleMatch) {
            const context = slugContext(moduleMatch[1])
            return { module: `module:${context}`, context }
        }
        const contractMatch = relative.match(/^gravity-mvp\/src\/contracts\/([^/]+)\//)
        if (contractMatch) {
            const context = slugContext(contractMatch[1])
            return { module: `contract:${context}`, context }
        }
        if (relative.startsWith('gravity-mvp/src/infrastructure/')) {
            return { module: 'shared_infrastructure', context: 'platform_shell' }
        }
        const module = compiledRules.find((rule) => rule.regex.test(relative))?.id ?? 'unclassified'
        return { module, context: moduleContext.get(module) ?? null }
    }

    const providerAllowedContexts = new Map()
    for (const manifest of effectiveManifests) {
        for (const relationship of manifest.provider_relationships ?? []) {
            const provider = policy.provider_aliases?.[relationship.name] ?? relationship.name
            if (!providerAllowedContexts.has(provider)) providerAllowedContexts.set(provider, new Set())
            providerAllowedContexts.get(provider).add(manifest.context.id)
        }
    }
    for (const [provider, contexts] of Object.entries(policy.provider_allowed_context_overrides ?? {})) {
        if (!providerAllowedContexts.has(provider)) providerAllowedContexts.set(provider, new Set())
        contexts.forEach((context) => providerAllowedContexts.get(provider).add(context))
    }

    const modelOwners = new Map()
    const tableOwners = new Map()
    for (const manifest of effectiveManifests) {
        for (const data of manifest.owned_data ?? []) {
            if (data.model) {
                modelOwners.set(data.model.toLowerCase(), { model: data.model, context: manifest.context.id })
                tableOwners.set(data.model.toLowerCase(), manifest.context.id)
            }
            if (data.mapped_table) tableOwners.set(data.mapped_table.toLowerCase(), manifest.context.id)
        }
        for (const id of manifest.owned_infrastructure_state ?? []) {
            const model = id.split(':').at(-1)
            modelOwners.set(model.toLowerCase(), { model, context: manifest.context.id })
        }
    }

    return {
        classifyFile,
        effectiveManifests,
        manifestsByContext,
        modelOwners,
        moduleContext,
        providerAllowedContexts,
        tableOwners,
    }
}

function resolveImport(root, source, specifier, fileSet) {
    let base
    if (specifier.startsWith('.')) base = path.resolve(path.dirname(path.join(root, source)), specifier)
    else if (specifier.startsWith('@/') && source.startsWith('gravity-mvp/')) {
        base = path.join(root, 'gravity-mvp/src', specifier.slice(2))
    } else return { relationship: 'external', target: specifier }

    if (path.extname(base) && existsSync(base)) {
        return { relationship: 'internal', target: path.relative(root, base).split(path.sep).join('/') }
    }

    const candidates = [base]
    if (/\.[cm]?js$/.test(base)) {
        const withoutJs = base.replace(/\.[cm]?js$/, '')
        for (const extension of ['.ts', '.tsx', '.mts', '.cts']) candidates.push(`${withoutJs}${extension}`)
    }
    for (const extension of CODE_EXTENSIONS) candidates.push(`${base}${extension}`)
    for (const extension of CODE_EXTENSIONS) candidates.push(path.join(base, `index${extension}`))
    for (const candidate of candidates) {
        const relative = path.relative(root, candidate).split(path.sep).join('/')
        if (fileSet.has(relative)) return { relationship: 'internal', target: relative }
    }
    return {
        relationship: 'unresolved_internal',
        target: path.relative(root, base).split(path.sep).join('/'),
    }
}

function isTestFile(relative, policy) {
    return policy.test_path_patterns.some((pattern) => relative.includes(pattern))
}

function matchesSurface(target, surface) {
    return target === surface || target.startsWith(`${surface}/`)
}

function isVersionedPublicTarget(target) {
    return /^gravity-mvp\/src\/modules\/[^/]+\/public\/v[1-9][0-9]*(?:\/|$)/.test(target)
        || /^gravity-mvp\/src\/contracts\/[^/]+\/v[1-9][0-9]*(?:\/|$)/.test(target)
}

function isSharedInfrastructure(target, policy) {
    return policy.shared_infrastructure_targets.some((prefix) => target === prefix || target.startsWith(prefix))
}

function providerForSpecifier(specifier, policy) {
    for (const [provider, patterns] of Object.entries(policy.provider_transport_packages)) {
        if (patterns.some((pattern) => new RegExp(pattern).test(specifier))) return provider
    }
    return null
}

function makeFinding(input) {
    return {
        rule: input.rule,
        file: input.file,
        line: input.line ?? null,
        source_context: input.sourceContext ?? null,
        target_context: input.targetContext ?? null,
        subject: input.subject,
        details: input.details ?? {},
    }
}

function finalizeFindings(findings) {
    const ordinals = new Map()
    return findings
        .sort((left, right) => left.file.localeCompare(right.file) || (left.line ?? 0) - (right.line ?? 0) || left.rule.localeCompare(right.rule) || left.subject.localeCompare(right.subject))
        .map((finding) => {
            const ordinalKey = `${finding.rule}|${finding.file}|${finding.subject}`
            const ordinal = (ordinals.get(ordinalKey) ?? 0) + 1
            ordinals.set(ordinalKey, ordinal)
            const identity = {
                rule: finding.rule,
                file: finding.file,
                source_context: finding.source_context,
                target_context: finding.target_context,
                subject: finding.subject,
                ordinal,
            }
            return { ...finding, ordinal, fingerprint: `arch_${digest(identity).slice(0, 24)}` }
        })
}

export async function scanArchitecture(root = repositoryRoot) {
    const policy = await loadJson(root, 'architecture/enforcement/v1/policy.json')
    const moduleRules = await loadJson(root, 'architecture/evidence/v1/module-rules.json')
    const providerEvidence = await loadJson(root, 'architecture/evidence/v1/provider-dependencies.json')
    const index = await loadJson(root, 'architecture/contexts/v1/context-index.json')
    const manifestIntegrityFindings = []
    const baseManifests = await Promise.all(index.contexts.map(async (entry) => {
        const raw = await readFile(path.join(root, entry.path), 'utf8')
        if (digest(raw) !== entry.sha256) {
            manifestIntegrityFindings.push({
                rule: 'manifest_inconsistency',
                file: entry.path,
                subject: `sha256:${entry.sha256}->${digest(raw)}`,
            })
        }
        const manifest = JSON.parse(raw)
        if (manifest.context?.id !== entry.context) {
            manifestIntegrityFindings.push({
                rule: 'manifest_inconsistency',
                file: entry.path,
                subject: `index-context:${entry.context}->${manifest.context?.id ?? 'missing'}`,
            })
        }
        return manifest
    }))
    const duplicateContexts = index.contexts
        .map((entry) => entry.context)
        .filter((context, position, contexts) => contexts.indexOf(context) !== position)
    for (const context of new Set(duplicateContexts)) {
        manifestIntegrityFindings.push({
            rule: 'manifest_inconsistency',
            file: 'architecture/contexts/v1/context-index.json',
            subject: `duplicate-context:${context}`,
        })
    }
    const amendments = await Promise.all(policy.manifest_amendments.map((item) => loadJson(root, item)))
    const state = contextState(policy, moduleRules, baseManifests, amendments)
    const excludes = new Set(policy.exclude_segments)
    const absoluteFiles = []
    for (const sourceRoot of policy.source_roots) await walk(path.join(root, sourceRoot), excludes, absoluteFiles)
    const files = absoluteFiles.map((absolute) => path.relative(root, absolute).split(path.sep).join('/')).sort()
    const fileSet = new Set(files)
    const bodies = new Map(await Promise.all(files.map(async (file) => [file, await readFile(path.join(root, file), 'utf8')])))
    const findings = [...manifestIntegrityFindings, ...validateManifestPolicy(state.effectiveManifests, amendments)]
    const sensitiveEnvironment = new RegExp(policy.sensitive_environment_pattern, 'i')
    const approvedWriters = new Set(policy.approved_infrastructure_writers.map((item) => `${item.file}|${item.model}`))
    const providersByFile = new Map()
    for (const provider of providerEvidence.providers) {
        const canonicalProvider = policy.provider_aliases?.[provider.provider] ?? provider.provider
        for (const evidence of provider.evidence) {
            // The CRM-ARCH-002 evidence inventory intentionally records broad
            // textual mentions.  Only a path match identifies a provider-facing
            // module strongly enough to enforce transport ownership here.  SDK
            // imports are enforced independently by providerForSpecifier().
            if (evidence.match_kind !== 'path') continue
            if (!providersByFile.has(evidence.file)) providersByFile.set(evidence.file, new Set())
            providersByFile.get(evidence.file).add(canonicalProvider)
        }
    }

    for (const file of files) {
        if (isTestFile(file, policy)) continue
        const body = bodies.get(file)
        const source = state.classifyFile(file)
        if (!source.context) {
            findings.push(makeFinding({
                rule: 'unclassified_production_source', file, sourceContext: null,
                subject: source.module,
            }))
            continue
        }
        const manifest = state.manifestsByContext.get(source.context)

        for (const imported of extractImports(body)) {
            const resolution = resolveImport(root, file, imported.specifier, fileSet)
            if (resolution.relationship === 'unresolved_internal') {
                findings.push(makeFinding({
                    rule: 'unresolved_internal_import', file, line: lineAt(body, imported.index),
                    sourceContext: source.context, subject: `${imported.specifier}->${resolution.target}`,
                }))
                continue
            }
            if (resolution.relationship === 'external') {
                const provider = providerForSpecifier(imported.specifier, policy)
                if (provider && !state.providerAllowedContexts.get(provider)?.has(source.context)) {
                    findings.push(makeFinding({
                        rule: 'direct_provider_transport_access', file, line: lineAt(body, imported.index),
                        sourceContext: source.context, subject: `${provider}:${imported.specifier}`,
                        details: { provider, specifier: imported.specifier },
                    }))
                }
                continue
            }

            const target = state.classifyFile(resolution.target)
            if (!target.context || target.context === source.context) continue
            for (const provider of providersByFile.get(resolution.target) ?? []) {
                if (!state.providerAllowedContexts.get(provider)?.has(source.context)) {
                    findings.push(makeFinding({
                        rule: 'direct_provider_transport_access', file, line: lineAt(body, imported.index),
                        sourceContext: source.context, targetContext: target.context,
                        subject: `provider-module:${provider}:${resolution.target}`,
                        details: { provider, specifier: imported.specifier, target: resolution.target },
                    }))
                }
            }

            if (isSharedInfrastructure(resolution.target, policy)) continue
            const targetManifest = state.manifestsByContext.get(target.context)
            const internalTarget = targetManifest.internal_surface.some((surface) => matchesSurface(resolution.target, surface))
                || /^gravity-mvp\/src\/modules\/[^/]+\/internal(?:\/|$)/.test(resolution.target)
            if (internalTarget) {
                findings.push(makeFinding({
                    rule: 'internal_module_import', file, line: lineAt(body, imported.index),
                    sourceContext: source.context, targetContext: target.context,
                    subject: `${source.module}>${target.module}:${resolution.target}`,
                    details: { specifier: imported.specifier, target: resolution.target },
                }))
            }
            const allowed = manifest.allowed_dependencies.some((dependency) => dependency.context === target.context)
            if (!allowed) {
                findings.push(makeFinding({
                    rule: 'undeclared_dependency', file, line: lineAt(body, imported.index),
                    sourceContext: source.context, targetContext: target.context,
                    subject: `${source.module}>${target.module}:${resolution.target}`,
                    details: { specifier: imported.specifier, target: resolution.target },
                }))
            }
            if (!isVersionedPublicTarget(resolution.target)) {
                findings.push(makeFinding({
                    rule: 'non_public_cross_context_import', file, line: lineAt(body, imported.index),
                    sourceContext: source.context, targetContext: target.context,
                    subject: `${source.module}>${target.module}:${resolution.target}`,
                    details: { specifier: imported.specifier, target: resolution.target },
                }))
            }
            const contractTarget = /^gravity-mvp\/src\/(?:contracts\/[^/]+|modules\/[^/]+\/public)(?:\/|$)/.test(resolution.target)
            if (contractTarget && !isVersionedPublicTarget(resolution.target)) {
                findings.push(makeFinding({
                    rule: 'contract_version_violation', file, line: lineAt(body, imported.index),
                    sourceContext: source.context, targetContext: target.context,
                    subject: `${imported.specifier}->${resolution.target}`,
                }))
            }
        }

        const allowedEnvironment = new Set(manifest.credential_relationships?.environment_names ?? [])
        for (const accessSite of extractEnvironmentAccess(body)) {
            if (sensitiveEnvironment.test(accessSite.name) && !allowedEnvironment.has(accessSite.name)) {
                findings.push(makeFinding({
                    rule: 'disallowed_credential_access', file, line: lineAt(body, accessSite.index),
                    sourceContext: source.context, subject: `environment:${accessSite.name}`,
                    details: { name: accessSite.name, type: 'environment' },
                }))
            }
        }

        for (const write of extractPrismaWrites(body)) {
            if (write.kind === 'model') {
                const owner = state.modelOwners.get(write.model.toLowerCase())
                if (!owner) {
                    findings.push(makeFinding({
                        rule: 'direct_foreign_prisma_write', file, line: lineAt(body, write.index),
                        sourceContext: source.context, subject: `UNOWNED:${write.model}.${write.method}`,
                        details: { model: write.model, method: write.method, owner: null },
                    }))
                } else if (
                    owner.context !== source.context
                    && !approvedWriters.has(`${file}|${owner.model}`)
                ) {
                    findings.push(makeFinding({
                        rule: 'direct_foreign_prisma_write', file, line: lineAt(body, write.index),
                        sourceContext: source.context, targetContext: owner.context,
                        subject: `${owner.model}.${write.method}`,
                        details: { model: owner.model, method: write.method, owner: owner.context },
                    }))
                }
            } else {
                const owners = [...new Set(write.tables.map((table) => state.tableOwners.get(table.toLowerCase())).filter(Boolean))]
                if (owners.length !== 1 || owners[0] !== source.context) {
                    findings.push(makeFinding({
                        rule: 'direct_foreign_prisma_write', file, line: lineAt(body, write.index),
                        sourceContext: source.context, targetContext: owners.length === 1 ? owners[0] : null,
                        subject: `raw:${write.method}:${write.tables.join(',') || 'dynamic'}`,
                        details: { method: write.method, tables: write.tables, owners },
                    }))
                }
            }
        }
    }

    let finalizedFindings = finalizeFindings(findings)
    if (policy.legacy_write_supplement) {
        const supplement = await loadJson(root, policy.legacy_write_supplement)
        const supplementalErrors = []
        const supplementalFingerprints = new Set()
        if (
            supplement.schema !== 'yoko.crm.architecture-legacy-write-supplement.v1'
            || supplement.controls?.site_count !== supplement.sites?.length
            || supplement.controls?.deadline !== policy.exception_review_deadline
            || supplement.controls?.wildcards !== false
        ) supplementalErrors.push('identity-or-controls')
        for (const site of supplement.sites ?? []) {
            if (supplementalFingerprints.has(site.fingerprint)) supplementalErrors.push(`duplicate:${site.fingerprint}`)
            supplementalFingerprints.add(site.fingerprint)
            const finding = finalizedFindings.find((item) => item.fingerprint === site.fingerprint)
            if (
                finding?.rule !== 'direct_foreign_prisma_write'
                || finding.file !== site.file
                || finding.source_context !== site.caller_context
                || finding.target_context !== site.owner_context
                || finding.subject !== site.operation
            ) supplementalErrors.push(`site-mismatch:${site.fingerprint}`)
        }
        if (supplementalErrors.length > 0) {
            finalizedFindings = finalizeFindings([
                ...findings,
                ...supplementalErrors.map((subject) => ({
                    rule: 'manifest_inconsistency',
                    file: policy.legacy_write_supplement,
                    subject: `legacy-write-supplement:${subject}`,
                })),
            ])
        }
    }

    return {
        policy,
        findings: finalizedFindings,
        scanned_files: files.length,
        contexts: state.effectiveManifests.length,
    }
}

export function evaluateFindings(findings, registry, policy, now = new Date()) {
    const errors = []
    const findingByFingerprint = new Map(findings.map((finding) => [finding.fingerprint, finding]))
    const exceptionByFingerprint = new Map()
    const unexceptionable = new Set(policy.unexceptionable_rules)

    if (policy.strict_exception_registry) {
        if (
            registry.schema !== 'yoko.crm.architecture-exception-registry.v1'
            || registry.version !== 1
            || registry.milestone !== policy.registry_milestone
            || registry.base_commit !== policy.registry_base_commit
            || registry.policy?.exact_fingerprint_only !== true
            || registry.policy?.stale_exceptions_fail !== true
            || registry.policy?.expired_exceptions_fail !== true
            || registry.policy?.uncovered_violations_fail !== true
            || registry.policy?.deadline !== policy.exception_review_deadline
        ) errors.push({ type: 'INVALID_REGISTRY_IDENTITY' })
        if (registry.finding_digest !== digest(findings)) {
            errors.push({ type: 'FINDING_DIGEST_MISMATCH', expected: digest(findings), actual: registry.finding_digest ?? null })
        }
    }

    for (const exception of registry.exceptions ?? []) {
        if (!exception.fingerprint || !exception.rule || !exception.file || !exception.owner_context
            || !exception.rationale || !exception.retirement || !exception.expires_on) {
            errors.push({ type: 'INVALID_EXCEPTION', exception })
            continue
        }
        if (exceptionByFingerprint.has(exception.fingerprint)) {
            errors.push({ type: 'DUPLICATE_EXCEPTION', fingerprint: exception.fingerprint })
            continue
        }
        exceptionByFingerprint.set(exception.fingerprint, exception)
        if (unexceptionable.has(exception.rule)) {
            errors.push({ type: 'UNEXCEPTIONABLE_RULE', fingerprint: exception.fingerprint, rule: exception.rule })
        }
        const expiry = new Date(`${exception.expires_on}T23:59:59.999Z`)
        if (Number.isNaN(expiry.getTime()) || now > expiry) {
            errors.push({ type: 'EXPIRED_EXCEPTION', fingerprint: exception.fingerprint, expires_on: exception.expires_on })
        }
    }

    for (const finding of findings) {
        if (unexceptionable.has(finding.rule) || !exceptionByFingerprint.has(finding.fingerprint)) {
            errors.push({ type: 'UNCOVERED_VIOLATION', finding })
        } else {
            const exception = exceptionByFingerprint.get(finding.fingerprint)
            if (
                exception.rule !== finding.rule
                || exception.file !== finding.file
                || exception.owner_context !== finding.source_context
                || (exception.target_context ?? null) !== finding.target_context
                || exception.subject !== finding.subject
                || exception.ordinal !== finding.ordinal
            ) {
                errors.push({ type: 'EXCEPTION_IDENTITY_MISMATCH', finding, exception })
            }
        }
    }
    for (const exception of registry.exceptions ?? []) {
        if (!findingByFingerprint.has(exception.fingerprint)) {
            errors.push({ type: 'STALE_EXCEPTION', fingerprint: exception.fingerprint, rule: exception.rule, file: exception.file })
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        findings: findings.length,
        exceptions: registry.exceptions?.length ?? 0,
        by_rule: Object.fromEntries([...new Set(findings.map((finding) => finding.rule))].sort().map((rule) => [
            rule,
            findings.filter((finding) => finding.rule === rule).length,
        ])),
    }
}

async function main() {
    const candidatesOnly = process.argv.includes('--candidates')
    const scan = await scanArchitecture(repositoryRoot)
    if (candidatesOnly) {
        process.stdout.write(`${JSON.stringify({
            schema: 'yoko.crm.architecture-finding-candidates.v1',
            generated_from: digest(scan.findings),
            scanned_files: scan.scanned_files,
            contexts: scan.contexts,
            findings: scan.findings,
        }, null, 2)}\n`)
        return
    }
    const registry = await loadJson(repositoryRoot, scan.policy.exception_registry)
    const result = evaluateFindings(scan.findings, registry, scan.policy)
    process.stdout.write(`${JSON.stringify({
        schema: 'yoko.crm.architecture-enforcement-result.v1',
        ...result,
        scanned_files: scan.scanned_files,
        contexts: scan.contexts,
    }, null, 2)}\n`)
    if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`${error.stack ?? error.message}\n`)
        process.exitCode = 1
    })
}
