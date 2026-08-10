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

test('extracts constant DDL table ownership without scanning unrelated later SQL', () => {
    const source = [
        'const TABLE_SQL = `CREATE TABLE IF NOT EXISTS execution_lock (id TEXT)`',
        'const INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS idx_lock ON execution_lock (id)`',
        'const ALTER_SQL = `DO $$ BEGIN ALTER TABLE execution_lock ADD COLUMN owner TEXT; END $$`',
        'await prisma.$executeRawUnsafe(TABLE_SQL)',
        'await prisma.$executeRawUnsafe(INDEX_SQL)',
        'await prisma.$executeRawUnsafe(ALTER_SQL)',
        'await prisma.$executeRawUnsafe(runtimeSelectedSql)',
        'const unrelated = `UPDATE "OtherTable" SET x = 1`',
    ].join('\n')
    const writes = extractPrismaWrites(source)
    assert.deepEqual(writes.map((write) => write.tables), [
        ['execution_lock'],
        ['execution_lock'],
        ['execution_lock'],
        [],
    ])
})

test('keeps mutable or ambiguous raw SQL expressions fail-closed', () => {
    const source = [
        'const CONCATENATED = `DELETE FROM beta_records` + suffix',
        'const INTERPOLATED = `DELETE FROM ${tableName}`',
        'const DUPLICATE = `DELETE FROM first_table`',
        '{ const DUPLICATE = `DELETE FROM second_table`; void DUPLICATE }',
        'await prisma.$executeRawUnsafe(CONCATENATED)',
        'await prisma.$executeRawUnsafe(INTERPOLATED)',
        'await prisma.$executeRawUnsafe(DUPLICATE)',
        'await prisma.$executeRawUnsafe(`DELETE FROM literal_table` + suffix)',
        'const LOCAL = `UPDATE local_table SET x = 1`',
        'await prisma.$executeRawUnsafe(LOCAL + attacker)',
        'function run(LOCAL) { return prisma.$executeRawUnsafe(LOCAL) }',
    ].join('\n')
    const writes = extractPrismaWrites(source)
    assert.deepEqual(writes.map((write) => write.tables), [[], [], ['first_table'], [], [], []])
    assert.deepEqual(writes.map((write) => write.dynamic), [true, true, false, true, true, true])
})

test('resolves static SQL constants by lexical symbol instead of name', () => {
    const writes = extractPrismaWrites([
        "import { SQL as importedSql } from './runtime-sql'",
        'const SQL = `UPDATE outer_table SET x = 1`',
        'await prisma.$executeRawUnsafe(SQL)',
        'function shadowed(x = fn(), SQL = importedSql) { return prisma.$executeRawUnsafe(SQL) }',
        'function nested() { const importedSql = `UPDATE nested_table SET x = 1`; return prisma.$executeRawUnsafe(importedSql) }',
    ].join('\n'))
    assert.deepEqual(writes.map((write) => write.tables), [['outer_table'], [], ['nested_table']])
    assert.deepEqual(writes.map((write) => write.dynamic), [false, true, false])
})

test('ignores SQL mutation words in comments and string values', () => {
    const writes = extractPrismaWrites([
        'await prisma.$executeRawUnsafe(`-- DELETE FROM comment_table',
        "INSERT INTO real_table (note) VALUES ('UPDATE string_table SET x = 1')`)",
        'await prisma.$executeRawUnsafe(`/* ALTER TABLE block_table */ CREATE INDEX idx_real ON real_table (id)`)',
        'await prisma.$executeRawUnsafe(`INSERT INTO health_snapshots (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1`)',
    ].join('\n'))
    assert.deepEqual(writes.map((write) => write.tables), [['real_table'], ['real_table'], ['health_snapshots']])
})

test('extracts literal DDL and keeps interpolated table names dynamic', () => {
    const writes = extractPrismaWrites([
        'await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS cron_health_log (id SERIAL)`)',
        'await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_cron ON cron_health_log (id)`)',
        'await prisma.$executeRawUnsafe(`DELETE FROM "${tableName}" WHERE id = $1`, id)',
    ].join('\n'))
    assert.deepEqual(writes.map((write) => write.tables), [
        ['cron_health_log'],
        ['cron_health_log'],
        [],
    ])
    assert.equal(writes[2].dynamic, true)
})

test('preserves schemas, all list targets, and mixed dynamic statements', () => {
    const writes = extractPrismaWrites([
        'await prisma.$executeRawUnsafe(`DROP TABLE local_one, foreign_two`)',
        'await prisma.$executeRawUnsafe(`TRUNCATE TABLE public.local_three, other.foreign_four`)',
        'await prisma.$executeRawUnsafe(`UPDATE local_five SET x = 1; DELETE FROM "${tableName}"`)',
        'await prisma.$executeRawUnsafe(`UPDATE "other.local_six" SET x = 1`)',
    ].join('\n'))
    assert.deepEqual(writes.map((write) => write.tables), [
        ['foreign_two', 'local_one'],
        ['local_three', 'other.foreign_four'],
        ['local_five'],
        ['other.local_six'],
    ])
    assert.equal(writes[2].dynamic, true)
})

test('does not truncate PostgreSQL identifiers or Prisma.raw template injection', () => {
    const writes = extractPrismaWrites([
        'await prisma.$executeRawUnsafe(`UPDATE local_table$suffix SET x = 1`)',
        'await prisma.$executeRawUnsafe(`UPDATE "local_table""suffix" SET x = 1`)',
        'await prisma.$executeRaw`UPDATE local_table SET x = ${value}; ${Prisma.raw(ok ? `DELETE FROM foreign_table` : ``)}`',
    ].join('\n'))
    assert.deepEqual(writes.map((write) => write.tables), [
        ['local_table$suffix'],
        ['local_table"suffix'],
        ['local_table'],
    ])
    assert.equal(writes[2].dynamic, true)
})

test('marks Prisma.sql aliases and every unsafe interpolation dynamic', () => {
    const writes = extractPrismaWrites([
        'const fragment = Prisma.raw',
        'const P = Prisma',
        'const { sql: destructured } = Prisma',
        'function wrapped() { return Prisma.sql`DELETE FROM wrapped_foreign RETURNING 1` }',
        'await prisma.$executeRaw`WITH x AS (${Prisma.sql`DELETE FROM foreign_one RETURNING 1`}) UPDATE local_one SET x = 1`',
        'await prisma.$executeRaw`UPDATE local_two SET x = 1; ${fragment(`DELETE FROM foreign_two`)}`',
        'await prisma.$executeRaw`UPDATE local_four SET x = 1; ${wrapped()}`',
        'await prisma.$executeRaw`UPDATE local_five SET x = 1; ${destructured`DELETE FROM foreign_five`}`',
        'await prisma.$executeRaw`UPDATE local_six SET x = 1; ${P.sql`DELETE FROM foreign_six`}`',
        'await prisma.$executeRaw`UPDATE local_seven SET x = 1; ${Prisma["raw"](`DELETE FROM foreign_seven`)}`',
        'await prisma.$executeRawUnsafe(`UPDATE local_three SET x = ${value}`)',
    ].join('\n'))
    assert.deepEqual(writes.map((write) => write.tables), [
        ['local_one'],
        ['local_two'],
        ['local_four'],
        ['local_five'],
        ['local_six'],
        ['local_seven'],
        ['local_three'],
    ])
    assert(writes.every((write) => write.dynamic))
})

test('keeps every tagged execute interpolation fail-closed, including plain-looking values', () => {
    const writes = extractPrismaWrites([
        'await prisma.$executeRaw`UPDATE local_one SET x = ${plainValue}`',
        'await prisma.$executeRaw`UPDATE local_two SET x = ${input.value}`',
        'await prisma.$executeRaw`UPDATE local_three SET x = ${box[0]}`',
    ].join('\n'))
    assert.deepEqual(writes.map((write) => write.tables), [['local_one'], ['local_two'], ['local_three']])
    assert(writes.every((write) => write.dynamic))
})

test('rejects truncated Unicode targets and preserves spaced qualification', () => {
    const writes = extractPrismaWrites([
        'await prisma.$executeRawUnsafe(`UPDATE local_tableé SET x = 1`)',
        'await prisma.$executeRawUnsafe(`UPDATE local_schema . foreign_one SET x = 1`)',
        'await prisma.$executeRawUnsafe(`UPDATE local_schema/**/.foreign_two SET x = 1`)',
    ].join('\n'))
    assert.deepEqual(writes.map((write) => write.tables), [
        [],
        ['local_schema.foreign_one'],
        ['local_schema.foreign_two'],
    ])
    assert.equal(writes[0].dynamic, true)
    assert.equal(writes[1].dynamic, false)
    assert.equal(writes[2].dynamic, false)
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

test('raw write fingerprints remain bound to the AST site when a sibling retires', async () => {
    const fixture = await makeFixture()
    try {
        const absolute = path.join(fixture.root, 'gravity-mvp/src/modules/alpha/main.ts')
        const original = await readFile(absolute, 'utf8')
        const first = 'await prisma.$executeRaw`UPDATE beta_records SET value = ${firstValue} WHERE id = 1`'
        const second = 'await prisma.$executeRaw`UPDATE beta_records SET value = ${secondValue} WHERE id = 2`'
        await writeFile(absolute, `${original}${first}\n${second}\n`)
        const before = (await scanArchitecture(fixture.root)).findings.filter((finding) => (
            finding.rule === 'direct_foreign_prisma_write'
            && finding.file === 'gravity-mvp/src/modules/alpha/main.ts'
            && finding.site_signature
        ))
        assert.equal(before.length, 2)
        await writeFile(absolute, `${original}${second}\n`)
        const after = (await scanArchitecture(fixture.root)).findings.filter((finding) => (
            finding.rule === 'direct_foreign_prisma_write'
            && finding.file === 'gravity-mvp/src/modules/alpha/main.ts'
            && finding.site_signature
        ))
        assert.equal(after.length, 1)
        assert.equal(after[0].fingerprint, before[1].fingerprint)
        assert(!after.some((finding) => finding.fingerprint === before[0].fingerprint))
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('byte-identical sibling retirement cannot transfer the retired fingerprint', async () => {
    const fixture = await makeFixture()
    try {
        const absolute = path.join(fixture.root, 'gravity-mvp/src/modules/alpha/main.ts')
        const original = await readFile(absolute, 'utf8')
        const duplicate = 'await prisma.$executeRaw`UPDATE beta_records SET value = ${sameValue} WHERE id = 1`'
        await writeFile(absolute, `${original}${duplicate}\n${duplicate}\n`)
        const before = (await scanArchitecture(fixture.root)).findings.filter((finding) => (
            finding.rule === 'direct_foreign_prisma_write'
            && finding.file === 'gravity-mvp/src/modules/alpha/main.ts'
            && finding.site_signature
        ))
        assert.equal(before.length, 2)
        await writeFile(absolute, `${original}${duplicate}\n`)
        const after = (await scanArchitecture(fixture.root)).findings.filter((finding) => (
            finding.rule === 'direct_foreign_prisma_write'
            && finding.file === 'gravity-mvp/src/modules/alpha/main.ts'
            && finding.site_signature
        ))
        assert.equal(after.length, 1)
        assert(!before.some((finding) => finding.fingerprint === after[0].fingerprint))
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

test('signed raw finding requires the exact site signature in its exception', () => {
    const signedFinding = { ...finding, site_signature: 'sha256:site' }
    const result = evaluateFindings([signedFinding], { exceptions: [validException] }, policy, new Date('2026-08-09T00:00:00Z'))
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
    const strictPolicy = {
        ...policy,
        strict_exception_registry: true,
        exception_review_deadline: '2026-12-31',
        registry_milestone: 'FIXTURE',
        registry_base_commit: 'fixture-base',
    }
    const registry = {
        schema: 'yoko.crm.architecture-exception-registry.v1',
        version: 1,
        milestone: 'FIXTURE',
        base_commit: 'fixture-base',
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
