#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
    evaluateFindings,
    extractEnvironmentAccess,
    extractImports,
    extractPrismaWrites,
    scanArchitecture,
    validateManifestPolicy,
} from './enforce-architecture.mjs'

const tests = []

function test(name, body) {
    tests.push({ name, body })
}

async function writeJson(root, relative, value) {
    const absolute = path.join(root, relative)
    await mkdir(path.dirname(absolute), { recursive: true })
    const raw = `${JSON.stringify(value, null, 2)}\n`
    await writeFile(absolute, raw)
    return createHash('sha256').update(raw).digest('hex')
}

function manifest(id, options = {}) {
    return {
        schema: 'fixture.context.v1',
        version: 1,
        context: { id },
        technical_modules: [],
        allowed_dependencies: options.allowed_dependencies ?? [],
        public_surface: [`gravity-mvp/src/modules/${id}/public/v1`],
        internal_surface: [`gravity-mvp/src/modules/${id}/internal`],
        events: [],
        commands: [],
        provider_relationships: options.provider_relationships ?? [],
        credential_relationships: { environment_names: options.environment_names ?? [] },
        owned_data: options.owned_data ?? [],
        owned_infrastructure_state: [],
    }
}

async function makeFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yoko-architecture-enforcement-'))
    const alpha = manifest('alpha')
    const beta = manifest('beta', { owned_data: [{ model: 'BetaRecord', mapped_table: 'beta_records' }] })
    const alphaPath = 'architecture/contexts/v1/manifests/alpha.json'
    const betaPath = 'architecture/contexts/v1/manifests/beta.json'
    const alphaHash = await writeJson(root, alphaPath, alpha)
    const betaHash = await writeJson(root, betaPath, beta)
    await writeJson(root, 'architecture/contexts/v1/context-index.json', {
        contexts: [
            { context: 'alpha', path: alphaPath, sha256: alphaHash },
            { context: 'beta', path: betaPath, sha256: betaHash },
        ],
    })
    await writeJson(root, 'architecture/evidence/v1/module-rules.json', { modules: [] })
    await writeJson(root, 'architecture/evidence/v1/provider-dependencies.json', { providers: [] })
    await writeJson(root, 'architecture/enforcement/v1/policy.json', {
        source_roots: ['gravity-mvp/src'],
        exclude_segments: ['node_modules'],
        test_path_patterns: ['/tests/', '.test.'],
        shared_infrastructure_targets: ['gravity-mvp/src/infrastructure/'],
        sensitive_environment_pattern: '(TOKEN|KEY|SECRET|PASSWORD)',
        provider_transport_packages: { openai: ['^openai$'] },
        provider_aliases: {},
        provider_allowed_context_overrides: {},
        approved_infrastructure_writers: [],
        manifest_amendments: [],
        exception_registry: 'architecture/enforcement/v1/exceptions.json',
        exception_review_deadline: '2026-12-31',
        unexceptionable_rules: [
            'manifest_inconsistency',
            'dependency_graph_cycle',
            'contract_version_violation',
            'unresolved_internal_import',
            'unclassified_production_source',
        ],
    })
    await writeJson(root, 'architecture/enforcement/v1/exceptions.json', { exceptions: [] })
    await writeJson(root, 'gravity-mvp/src/modules/alpha/placeholder.json', {})
    await mkdir(path.join(root, 'gravity-mvp/src/modules/alpha'), { recursive: true })
    await writeFile(path.join(root, 'gravity-mvp/src/modules/alpha/main.ts'), [
        "import { secret } from '../beta/internal/secret'",
        "import { createThing } from '../../contracts/beta/CreateThing'",
        "import OpenAI from 'openai'",
        'void secret; void createThing; void OpenAI',
        'prisma.betaRecord.create({ data: {} })',
        'void process.env.OPENAI_API_KEY',
        '',
    ].join('\n'))
    await mkdir(path.join(root, 'gravity-mvp/src/modules/beta/internal'), { recursive: true })
    await writeFile(path.join(root, 'gravity-mvp/src/modules/beta/internal/secret.ts'), 'export const secret = true\n')
    await mkdir(path.join(root, 'gravity-mvp/src/contracts/beta'), { recursive: true })
    await writeFile(path.join(root, 'gravity-mvp/src/contracts/beta/CreateThing.ts'), 'export const createThing = true\n')
    return { root, betaPath }
}

test('extracts imports while ignoring comments', () => {
    const imports = extractImports("// import x from 'ignored'\nimport x from 'kept'\nconst example = \"require('ignored-string')\"\n/* require('ignored-two') */")
    assert.deepEqual(imports.map((item) => item.specifier), ['kept'])
})

test('nested template expressions do not hide later source', () => {
    const source = 'const value = `outer ${ready ? `nested ${id}` : "none"}`; prisma.task.update({}); process.env.API_KEY'
    assert.equal(extractPrismaWrites(source).length, 1)
    assert.deepEqual(extractEnvironmentAccess(source).map((item) => item.name), ['API_KEY'])
})

test('extracts sensitive environment access forms', () => {
    const names = extractEnvironmentAccess("process.env.API_KEY; process.env['BOT_TOKEN']; env('DB_PASSWORD'); const example = 'process.env.FALSE_SECRET'")
        .map((item) => item.name)
    assert.deepEqual(names, ['API_KEY', 'BOT_TOKEN', 'DB_PASSWORD'])
})

test('extracts Prisma model and raw writes', () => {
    const writes = extractPrismaWrites('prisma.task.create({}); await tx.$executeRaw`UPDATE "Message" SET x = 1`; const example = "prisma.user.delete({})"')
    assert.equal(writes[0].model, 'task')
    assert.equal(writes[0].method, 'create')
    assert.deepEqual(writes[1].tables, ['Message'])
})

test('integration fixture detects every enforced mutation class', async () => {
    const fixture = await makeFixture()
    try {
        const scan = await scanArchitecture(fixture.root)
        const rules = new Set(scan.findings.map((finding) => finding.rule))
        for (const rule of [
            'internal_module_import',
            'non_public_cross_context_import',
            'undeclared_dependency',
            'contract_version_violation',
            'direct_provider_transport_access',
            'disallowed_credential_access',
            'direct_foreign_prisma_write',
        ]) assert(rules.has(rule), `missing fixture finding ${rule}`)
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('manifest byte drift is unexceptionable', async () => {
    const fixture = await makeFixture()
    try {
        const absolute = path.join(fixture.root, fixture.betaPath)
        const original = await readFile(absolute, 'utf8')
        await writeFile(absolute, original.replace('"version": 1', '"version": 2'))
        const scan = await scanArchitecture(fixture.root)
        assert(scan.findings.some((finding) => finding.rule === 'manifest_inconsistency' && finding.file === fixture.betaPath))
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('manifest dependency cycles fail validation', () => {
    const alpha = manifest('alpha', { allowed_dependencies: [{ context: 'beta' }] })
    const beta = manifest('beta', { allowed_dependencies: [{ context: 'alpha' }] })
    assert(validateManifestPolicy([alpha, beta], []).some((finding) => finding.rule === 'dependency_graph_cycle'))
})

const finding = {
    rule: 'undeclared_dependency',
    file: 'gravity-mvp/src/modules/alpha/main.ts',
    line: 1,
    source_context: 'alpha',
    target_context: 'beta',
    subject: 'alpha>beta:internal',
    details: {},
    ordinal: 1,
    fingerprint: 'arch_fixture',
}
const policy = {
    unexceptionable_rules: [
        'manifest_inconsistency',
        'dependency_graph_cycle',
        'contract_version_violation',
        'unresolved_internal_import',
        'unclassified_production_source',
    ],
}
const validException = {
    fingerprint: finding.fingerprint,
    rule: finding.rule,
    file: finding.file,
    owner_context: finding.source_context,
    target_context: finding.target_context,
    subject: finding.subject,
    ordinal: finding.ordinal,
    rationale: 'legacy fixture',
    retirement: 'remove dependency',
    expires_on: '2026-12-31',
}

test('exact active exception passes', () => {
    assert.equal(evaluateFindings([finding], { exceptions: [validException] }, policy, new Date('2026-08-09T00:00:00Z')).ok, true)
})

test('new uncovered violation fails', () => {
    const result = evaluateFindings([finding], { exceptions: [] }, policy, new Date('2026-08-09T00:00:00Z'))
    assert(result.errors.some((error) => error.type === 'UNCOVERED_VIOLATION'))
})

test('removed violation leaves a failing stale exception', () => {
    const result = evaluateFindings([], { exceptions: [validException] }, policy, new Date('2026-08-09T00:00:00Z'))
    assert(result.errors.some((error) => error.type === 'STALE_EXCEPTION'))
})

test('expired exception fails', () => {
    const result = evaluateFindings([finding], { exceptions: [validException] }, policy, new Date('2027-01-01T00:00:00Z'))
    assert(result.errors.some((error) => error.type === 'EXPIRED_EXCEPTION'))
})

test('duplicate exception fails', () => {
    const result = evaluateFindings([finding], { exceptions: [validException, validException] }, policy, new Date('2026-08-09T00:00:00Z'))
    assert(result.errors.some((error) => error.type === 'DUPLICATE_EXCEPTION'))
})

test('incomplete exception fails', () => {
    const result = evaluateFindings([finding], { exceptions: [{ fingerprint: finding.fingerprint }] }, policy, new Date('2026-08-09T00:00:00Z'))
    assert(result.errors.some((error) => error.type === 'INVALID_EXCEPTION'))
})

test('exception identity mismatch fails', () => {
    const result = evaluateFindings([finding], { exceptions: [{ ...validException, subject: 'different' }] }, policy, new Date('2026-08-09T00:00:00Z'))
    assert(result.errors.some((error) => error.type === 'EXCEPTION_IDENTITY_MISMATCH'))
})

test('unexceptionable rule cannot be baselined', () => {
    for (const rule of policy.unexceptionable_rules) {
        const strictFinding = { ...finding, rule }
        const strictException = { ...validException, rule }
        const result = evaluateFindings([strictFinding], { exceptions: [strictException] }, policy, new Date('2026-08-09T00:00:00Z'))
        assert(result.errors.some((error) => error.type === 'UNEXCEPTIONABLE_RULE'), rule)
        assert(result.errors.some((error) => error.type === 'UNCOVERED_VIOLATION'), rule)
    }
})

test('strict registry finding digest drift fails', () => {
    const strictPolicy = { ...policy, strict_exception_registry: true, exception_review_deadline: '2026-12-31' }
    const registry = {
        schema: 'yoko.crm.architecture-exception-registry.v1',
        version: 1,
        finding_digest: 'not-the-current-digest',
        policy: {
            exact_fingerprint_only: true,
            stale_exceptions_fail: true,
            expired_exceptions_fail: true,
            uncovered_violations_fail: true,
            deadline: '2026-12-31',
        },
        exceptions: [validException],
    }
    const result = evaluateFindings([finding], registry, strictPolicy, new Date('2026-08-09T00:00:00Z'))
    assert(result.errors.some((error) => error.type === 'FINDING_DIGEST_MISMATCH'))
})

let failed = 0
for (const item of tests) {
    try {
        await item.body()
        process.stdout.write(`ok - ${item.name}\n`)
    } catch (error) {
        failed += 1
        process.stderr.write(`not ok - ${item.name}\n${error.stack ?? error.message}\n`)
    }
}
process.stdout.write(`${tests.length - failed}/${tests.length} architecture enforcement tests passed\n`)
if (failed > 0) process.exitCode = 1
