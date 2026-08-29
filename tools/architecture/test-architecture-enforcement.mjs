#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
    evaluateFindings,
    extractEnvironmentAccess,
    extractCommonJsPublicExposure,
    extractImports,
    extractPrismaWrites,
    extractPublicWriteCapabilityExposure,
    extractUnsafeContactMergeCompositionExports,
    extractUnsafeApplicationCompositionExports,
    isApprovedContactMergeCompositionImport,
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
            'public_facade_internal_import',
            'public_facade_implementation_laundering',
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
    await mkdir(path.join(root, 'gravity-mvp/src/modules/alpha/internal'), { recursive: true })
    await writeFile(path.join(root, 'gravity-mvp/src/modules/alpha/internal/secret.ts'), 'export const secret = true\n')
    await mkdir(path.join(root, 'gravity-mvp/src/contracts/beta'), { recursive: true })
    await writeFile(path.join(root, 'gravity-mvp/src/contracts/beta/CreateThing.ts'), 'export const createThing = true\n')
    await mkdir(path.join(root, 'gravity-mvp/src/modules/alpha/public/v1'), { recursive: true })
    await writeFile(path.join(root, 'gravity-mvp/src/modules/alpha/public/v1/view.ts'), 'export const view = true\n')
    await writeFile(path.join(root, 'gravity-mvp/src/modules/alpha/public/v1/facade.ts'), [
        "import { secret } from '../../internal/secret'",
        "import { view } from './view'",
        'void secret; void view',
        '',
    ].join('\n'))
    return { root, betaPath }
}

async function writeFixtureFiles(root, files) {
    for (const [relative, body] of Object.entries(files)) {
        const absolute = path.join(root, relative)
        await mkdir(path.dirname(absolute), { recursive: true })
        await writeFile(absolute, body)
    }
}

function reachablePublicLeaks(scan) {
    return scan.findings.filter((finding) => (
        finding.rule === 'public_facade_implementation_laundering'
        && finding.subject.startsWith('reachable-export-implementation:')
    ))
}

test('extracts imports while ignoring comments', () => {
    const imports = extractImports("// import x from 'ignored'\nimport x from 'kept'\nconst example = \"require('ignored-string')\"\n/* require('ignored-two') */")
    assert.deepEqual(imports.map((item) => item.specifier), ['kept'])
})

test('extracts exact static bindings and CommonJS factory aliases', () => {
    const imports = extractImports([
        "import { createRequire as makeRequire } from 'node:module'",
        "import { exact as localExact, other } from './adapter'",
        'const localRequire = makeRequire(import.meta.url)',
        "const adapter = localRequire('./legacy-adapter')",
        "const second = module.require('./second-adapter')",
    ].join('\n'))
    const staticAdapter = imports.find((record) => record.kind === 'static' && record.specifier === './adapter')
    assert.deepEqual(staticAdapter.imports, [
        { kind: 'named', imported: 'exact', local: 'localExact' },
        { kind: 'named', imported: 'other', local: 'other' },
    ])
    assert.deepEqual(imports.filter((record) => record.kind === 'require').map((record) => record.specifier), [
        './legacy-adapter',
        './second-adapter',
    ])
})

test('detects CommonJS exports in a public source', () => {
    assert.deepEqual(extractCommonJsPublicExposure([
        'module.exports = { view: true }',
        'exports.other = true',
        "Object.defineProperty(module.exports, 'third', { value: true })",
    ].join('\n')).map((record) => record.subject), [
        'public-commonjs-export-assignment',
        'public-commonjs-export-assignment',
        'public-commonjs-defineProperty',
    ])
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

test('extracts exported transaction capability injection from a public facade', () => {
    const exposures = extractPublicWriteCapabilityExposure([
        'export interface ReadyUnitOfWork { run(operation: unknown): Promise<void> }',
        'export const createReady = (transaction: ReadyTransaction) => transaction',
    ].join('\n'))
    assert.deepEqual(exposures.map((exposure) => exposure.subject), [
        'exported-capability:ReadyUnitOfWork',
        'createReady:parameter:transaction: ReadyTransaction',
    ])
})

test('application composition exports must be narrow functions, not value reexports or objects', () => {
    assert.deepEqual(extractUnsafeApplicationCompositionExports([
        "export { adapter as executeV1 } from '../internal/adapter'",
        'export const safeV1 = (input: unknown) => input',
        'export const leakedV1 = adapter',
    ].join('\n')).map((record) => record.subject), [
        'composition-value-reexport',
        'composition-nonfunction-export:leakedV1',
    ])
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
            'public_facade_internal_import',
            'direct_provider_transport_access',
            'disallowed_credential_access',
            'direct_foreign_prisma_write',
        ]) assert(rules.has(rule), `missing fixture finding ${rule}`)
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('manifest amendments own source-isolated state for raw SQL as well as Prisma model writes', async () => {
    const fixture = await makeFixture()
    const amendmentPath = 'architecture/isolation/alpha/queue-v1/module-manifest-amendments.json'
    try {
        const policyPath = path.join(fixture.root, 'architecture/enforcement/v1/policy.json')
        const policy = JSON.parse(await readFile(policyPath, 'utf8'))
        policy.manifest_amendments = [amendmentPath]
        await writeJson(fixture.root, 'architecture/enforcement/v1/policy.json', policy)
        await writeJson(fixture.root, amendmentPath, {
            schema: 'yoko.crm.module-manifest-amendments.v1',
            version: 1,
            milestone: 'fixture',
            amendments: [{
                context: 'alpha',
                add_owned_infrastructure_state: [
                    'architecture/isolation/alpha/queue-v1/migration.sql:AlphaQueue',
                ],
            }],
        })
        const adapter = 'gravity-mvp/src/modules/alpha/internal/queue-adapter.ts'
        await writeFixtureFiles(fixture.root, {
            [adapter]: 'await prisma.$executeRawUnsafe(`UPDATE "AlphaQueue" SET "state"=\'ready\'`)\n',
        })

        const findings = (await scanArchitecture(fixture.root)).findings
        assert.equal(findings.some((finding) => (
            finding.rule === 'direct_foreign_prisma_write'
            && finding.file === adapter
        )), false)
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('public facades cannot import internal modules, including their own context', async () => {
    const fixture = await makeFixture()
    try {
        const scan = await scanArchitecture(fixture.root)
        const violations = scan.findings.filter((finding) => (
            finding.rule === 'public_facade_internal_import'
            && finding.file === 'gravity-mvp/src/modules/alpha/public/v1/facade.ts'
        ))
        assert.equal(violations.length, 1)
        assert.equal(violations[0].source_context, 'alpha')
        assert.equal(violations[0].target_context, 'alpha')
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('type-only syntax cannot expose or depend on a private internal implementation through a public facade', async () => {
    const fixture = await makeFixture()
    const facadePath = 'gravity-mvp/src/modules/alpha/public/v1/facade.ts'
    try {
        for (const body of [
            "import type { PrismaAdapter } from '../../internal/prisma-adapter'\nexport type PublicAdapter = PrismaAdapter\n",
            "export type { PrismaAdapter } from '../../internal/prisma-adapter'\n",
            "export { type PrismaAdapter } from '../../internal/prisma-adapter'\n",
            "export type PublicAdapter = import('../../internal/prisma-adapter').PrismaAdapter\n",
        ]) {
            await writeFixtureFiles(fixture.root, {
                [facadePath]: body,
                'gravity-mvp/src/modules/alpha/internal/prisma-adapter.ts': 'export type PrismaAdapter = { readonly kind: \'private\' }\n',
            })
            const findings = (await scanArchitecture(fixture.root)).findings
            assert(findings.some((finding) => (
                finding.rule === 'public_facade_internal_import'
                && finding.file === facadePath
            )), `type-only private implementation exposure must fail: ${body.trim()}`)
        }
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('type-only application hops cannot launder a private implementation type while local DTOs remain public', async () => {
    const fixture = await makeFixture()
    const facadePath = 'gravity-mvp/src/modules/alpha/public/v1/facade.ts'
    try {
        await writeFixtureFiles(fixture.root, {
            [facadePath]: [
                "export type { PublicPrismaRepository } from '../../application/public-types'",
                "export type { PublicResultV1 } from '../../application/public-dto'",
                '',
            ].join('\n'),
            'gravity-mvp/src/modules/alpha/application/public-types.ts': "export type { PrivatePrismaRepository as PublicPrismaRepository } from '../internal/private-prisma-repository'\n",
            'gravity-mvp/src/modules/alpha/application/public-dto.ts': 'export interface PublicResultV1 { readonly id: string }\n',
            'gravity-mvp/src/modules/alpha/internal/private-prisma-repository.ts': "export interface PrivatePrismaRepository { readonly implementation: 'prisma' }\n",
        })
        const findings = (await scanArchitecture(fixture.root)).findings.filter((finding) => (
            finding.rule === 'public_facade_implementation_laundering'
            && finding.file === facadePath
            && finding.subject.startsWith('reachable-export-internal-type:')
        ))
        assert(findings.some((finding) => finding.subject.endsWith(':PublicPrismaRepository')),
            'a private type must remain tainted through an application re-export')
        assert.equal(findings.some((finding) => finding.subject.endsWith(':PublicResultV1')), false,
            'a locally declared narrow DTO must remain a valid public type')
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('a matching legacy hash registry cannot suppress public implementation exposure', async () => {
    const fixture = await makeFixture()
    try {
        const facadePath = 'gravity-mvp/src/modules/alpha/public/v1/facade.ts'
        const adapterPath = 'gravity-mvp/src/modules/alpha/internal/prisma-adapter.ts'
        const facadeBody = "export { prismaAdapter } from '../../internal/prisma-adapter'\n"
        await writeFixtureFiles(fixture.root, {
            [facadePath]: facadeBody,
            [adapterPath]: "export const prismaAdapter = { kind: 'private-prisma-adapter' }\n",
        })
        await writeJson(fixture.root, 'architecture/enforcement/v1/frozen-public-implementation-debt.json', {
            schema: 'yoko.crm.frozen-public-implementation-debt.v1',
            version: 1,
            records: [{
                path: facadePath,
                sha256: createHash('sha256').update(facadeBody).digest('hex'),
                size: Buffer.byteLength(facadeBody),
            }],
        })
        const policyPath = path.join(fixture.root, 'architecture/enforcement/v1/policy.json')
        const policy = JSON.parse(await readFile(policyPath, 'utf8'))
        policy.frozen_public_implementation_debt = 'architecture/enforcement/v1/frozen-public-implementation-debt.json'
        await writeJson(fixture.root, 'architecture/enforcement/v1/policy.json', policy)

        const findings = (await scanArchitecture(fixture.root)).findings
        assert(findings.some((finding) => (
            finding.rule === 'public_facade_internal_import'
            && finding.file === facadePath
        )))
        assert(findings.some((finding) => (
            finding.rule === 'public_facade_implementation_laundering'
            && finding.file === facadePath
            && finding.subject === 'reachable-export-implementation:prismaAdapter'
        )))
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('only the named contact-merge root may bind its three private owner adapters', () => {
    const source = 'gravity-mvp/src/infrastructure/contact-merge-composition.ts'
    const contacts = 'gravity-mvp/src/modules/contacts/public/v1/legacy-prisma-contact-merge-adapter.ts'
    const allowed = { kind: 'static', imports: [{
        kind: 'named', imported: 'legacyPrismaContactMergeQueriesV1', local: 'legacyPrismaContactMergeQueriesV1',
    }] }
    assert.equal(isApprovedContactMergeCompositionImport(source, contacts, allowed), true)
    assert.equal(isApprovedContactMergeCompositionImport(source, contacts, {
        kind: 'static', imports: [{ kind: 'named', imported: 'eraseAllContacts', local: 'eraseAllContacts' }],
    }), false)
    assert.equal(isApprovedContactMergeCompositionImport(source, contacts, {
        kind: 'static', imports: [{ kind: 'named', imported: 'legacyPrismaContactMergeQueriesV1', local: 'aliasedQuery' }],
    }), false)
    assert.equal(isApprovedContactMergeCompositionImport(source, contacts, {
        kind: 'static', imports: [{ kind: 'namespace', imported: '*', local: 'contacts' }],
    }), false)
    assert.equal(isApprovedContactMergeCompositionImport(
        'gravity-mvp/src/infrastructure/other-composition.ts',
        contacts,
        allowed,
    ), false)
    assert.equal(isApprovedContactMergeCompositionImport(
        source,
        'gravity-mvp/src/modules/contacts/public/v1/legacy-prisma-other-adapter.ts',
        allowed,
    ), false)
})

test('the named contact-merge root cannot launder an allowed private adapter import', () => {
    assert.deepEqual(extractUnsafeContactMergeCompositionExports([
        "import { createMergeContactsHandlerV1 } from '@/modules/contacts/public/v1'",
        "import { makeAdapter } from '@/modules/contacts/public/v1/legacy-prisma-contact-merge-adapter'",
        'export const mergeContactsV1 = createMergeContactsHandlerV1({ unitOfWork })',
        '',
    ].join('\n')), [])
    const leaks = extractUnsafeContactMergeCompositionExports([
        "import { createMergeContactsHandlerV1 } from '@/modules/contacts/public/v1'",
        "import { makeAdapter } from '@/modules/contacts/public/v1/legacy-prisma-contact-merge-adapter'",
        'export { makeAdapter }',
        'export const leakedAdapter = makeAdapter',
        '',
    ].join('\n'))
    assert.deepEqual(leaks.map((entry) => entry.subject), [
        'contact-merge-value-reexport',
        'contact-merge-nonbusiness-export:leakedAdapter',
    ])
    const provenance = extractUnsafeContactMergeCompositionExports([
        "import { createMergeContactsHandlerV1 as realFactory } from '@/modules/contacts/public/v1'",
        'const createMergeContactsHandlerV1 = () => ({})',
        'export const mergeContactsV1 = createMergeContactsHandlerV1({ unitOfWork })',
        '',
    ].join('\n'))
    assert(provenance.some((entry) => entry.subject === 'contact-merge-unproven-factory-provenance'))
    assert(provenance.some((entry) => entry.subject === 'contact-merge-shadowed-factory-provenance'))
})

test('public facade imports within the public surface remain allowed', async () => {
    const fixture = await makeFixture()
    try {
        const facade = path.join(fixture.root, 'gravity-mvp/src/modules/alpha/public/v1/facade.ts')
        await writeFile(facade, "import { view } from './view'\nvoid view\n")
        const scan = await scanArchitecture(fixture.root)
        assert.equal(scan.findings.some((finding) => (
            finding.rule === 'public_facade_internal_import'
            && finding.file === 'gravity-mvp/src/modules/alpha/public/v1/facade.ts'
        )), false)
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('same-context public barrels may expose only exact clean symbols from semantic implementation sources', async () => {
    const fixture = await makeFixture()
    try {
        const facadePath = 'gravity-mvp/src/modules/alpha/public/v1/facade.ts'
        const implementationPath = 'gravity-mvp/src/modules/alpha/public/v1/prisma-operation.ts'
        await writeFixtureFiles(fixture.root, {
            [implementationPath]: [
                "import { prisma } from '@/lib/prisma'",
                'export async function executeAlphaV1(id: string) {',
                '  await prisma.alphaRecord.findUnique({ where: { id } })',
                '  return { id }',
                '}',
                'export const alphaOperationMetadataV1 = { version: 1 }',
                'export const legacyPrismaAlphaPortV1 = { find: () => prisma.alphaRecord }',
                'export const leakedClientV1 = prisma',
                'export default executeAlphaV1',
                '',
            ].join('\n'),
            'gravity-mvp/src/lib/prisma.ts': 'export const prisma = { alphaRecord: { findUnique: async (_input: unknown) => null } }\n',
            [facadePath]: "export { executeAlphaV1, alphaOperationMetadataV1 } from './prisma-operation'\n",
        })
        let scan = await scanArchitecture(fixture.root)
        assert.equal(scan.findings.some((finding) => (
            finding.rule === 'public_facade_internal_import' && finding.file === facadePath
        )), false)
        assert.equal(reachablePublicLeaks(scan).some((finding) => finding.file === facadePath), false)

        await writeFile(path.join(fixture.root, facadePath), "import { executeAlphaV1 as aliasedOperation } from './prisma-operation'\nexport { aliasedOperation }\n")
        scan = await scanArchitecture(fixture.root)
        assert(scan.findings.some((finding) => (
            finding.rule === 'public_facade_internal_import' && finding.file === facadePath
        )), 'an aliased implementation binding must not become a public API')

        await writeFile(path.join(fixture.root, facadePath), "import * as implementation from './prisma-operation'\nexport const executeAlphaV1 = implementation.executeAlphaV1\n")
        scan = await scanArchitecture(fixture.root)
        assert(scan.findings.some((finding) => (
            finding.rule === 'public_facade_internal_import' && finding.file === facadePath
        )), 'a namespace implementation binding must fail closed')

        await writeFile(path.join(fixture.root, facadePath), "export { leakedClientV1 } from './prisma-operation'\n")
        scan = await scanArchitecture(fixture.root)
        assert(reachablePublicLeaks(scan).some((finding) => (
            finding.file === facadePath && finding.subject.endsWith(':leakedClientV1')
        )), 'a tainted implementation identity must not be re-exported')

        const betaConsumer = 'gravity-mvp/src/modules/beta/public/v1/consumer.ts'
        await writeFixtureFiles(fixture.root, {
            [betaConsumer]: "import { executeAlphaV1 as executeAlphaOperationV1 } from '../../../alpha/public/v1/prisma-operation'\nvoid executeAlphaOperationV1\n",
        })
        scan = await scanArchitecture(fixture.root)
        for (const rule of ['internal_module_import', 'non_public_cross_context_import', 'contract_version_violation']) {
            assert.equal(scan.findings.some((finding) => finding.rule === rule && finding.file === betaConsumer), false,
                `a cross-context named binding with exact symbol metadata may consume a clean business operation (${rule})`)
        }

        await writeFile(path.join(fixture.root, betaConsumer), "import * as implementation from '../../../alpha/public/v1/prisma-operation'\nvoid implementation.executeAlphaV1\n")
        scan = await scanArchitecture(fixture.root)
        assert(scan.findings.some((finding) => finding.rule === 'internal_module_import' && finding.file === betaConsumer),
            'a cross-context namespace binding must fail closed')

        await writeFile(path.join(fixture.root, betaConsumer), "import defaultOperation from '../../../alpha/public/v1/prisma-operation'\nvoid defaultOperation\n")
        scan = await scanArchitecture(fixture.root)
        assert(scan.findings.some((finding) => finding.rule === 'non_public_cross_context_import' && finding.file === betaConsumer),
            'a cross-context default binding must fail closed')

        await writeFile(path.join(fixture.root, betaConsumer), "import { unknownAlphaOperationV1 } from '../../../alpha/public/v1/prisma-operation'\nvoid unknownAlphaOperationV1\n")
        scan = await scanArchitecture(fixture.root)
        assert(scan.findings.some((finding) => finding.rule === 'contract_version_violation' && finding.file === betaConsumer),
            'an unproven cross-context symbol must fail closed')

        await writeFile(path.join(fixture.root, betaConsumer), "import { legacyPrismaAlphaPortV1 } from '../../../alpha/public/v1/prisma-operation'\nvoid legacyPrismaAlphaPortV1\n")
        scan = await scanArchitecture(fixture.root)
        assert(scan.findings.some((finding) => finding.rule === 'internal_module_import' && finding.file === betaConsumer),
            'a legacy persistence port must never become a cross-context public operation')
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('same-context public barrels prove each value export from semantic implementations and reject side-effect escapes', async () => {
    const fixture = await makeFixture()
    const facadePath = 'gravity-mvp/src/modules/alpha/public/v1/facade.ts'
    const implementationPath = 'gravity-mvp/src/modules/alpha/public/v1/driver-messaging-capability.ts'
    try {
        await writeFixtureFiles(fixture.root, {
            [facadePath]: "export { sendDriverMessageV1 } from './driver-messaging-capability'\n",
            [implementationPath]: [
                "import { prisma } from '@/lib/prisma'",
                'export async function sendDriverMessageV1(id: string, onReady?: (value: { id: string }) => void) {',
                '  await prisma.alphaRecord.findUnique({ where: { id } })',
                '  const result = { id }',
                '  onReady?.(result)',
                '  return result',
                '}',
                '',
            ].join('\n'),
            'gravity-mvp/src/lib/prisma.ts': 'export const prisma = { alphaRecord: { findUnique: async (_input: unknown) => null } }\n',
        })
        let scan = await scanArchitecture(fixture.root)
        assert.equal(scan.findings.some((finding) => (
            finding.rule === 'public_facade_internal_import' && finding.file === facadePath
        )), false, 'an exact narrow value operation must remain allowed')

        await writeFile(path.join(fixture.root, implementationPath), [
            "import { prisma } from '@/lib/prisma'",
            'export async function sendDriverMessageV1(callback: (value: unknown) => void) {',
            '  callback(prisma)',
            '  return { ok: true }',
            '}',
            '',
        ].join('\n'))
        scan = await scanArchitecture(fixture.root)
        assert(scan.findings.some((finding) => (
            finding.rule === 'public_facade_internal_import' && finding.file === facadePath
        )), 'a caller-controlled side-effect escape must make the exact value binding non-public')

        await writeFile(path.join(fixture.root, implementationPath), [
            "import { prisma } from '@/lib/prisma'",
            'export function sendDriverMessageV1() { return prisma }',
            '',
        ].join('\n'))
        scan = await scanArchitecture(fixture.root)
        assert(scan.findings.some((finding) => (
            finding.rule === 'public_facade_implementation_laundering'
            && finding.file === facadePath
            && finding.subject.endsWith(':sendDriverMessageV1')
        )), 'a returned Prisma identity must remain rejected')
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('public business facades reject exported Prisma and provider implementation identities', async () => {
    const fixture = await makeFixture()
    try {
        const facade = path.join(fixture.root, 'gravity-mvp/src/modules/alpha/public/v1/facade.ts')
        await writeFile(facade, [
            "import { PrismaClient } from '@prisma/client'",
            "import OpenAI from 'openai'",
            'export const leakedPrisma = PrismaClient',
            'export const leakedProvider = OpenAI',
            '',
        ].join('\n'))
        const violations = (await scanArchitecture(fixture.root)).findings.filter((finding) => (
            finding.rule === 'public_facade_implementation_laundering'
            && finding.file === 'gravity-mvp/src/modules/alpha/public/v1/facade.ts'
        ))
        assert(violations.some((finding) => finding.subject === 'reachable-export-implementation:leakedPrisma'))
        assert(violations.some((finding) => finding.subject === 'reachable-export-implementation:leakedProvider'))
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('public index barrels cannot export Prisma or provider implementation identities', async () => {
    const fixture = await makeFixture()
    try {
        const index = path.join(fixture.root, 'gravity-mvp/src/modules/alpha/public/v1/index.ts')
        const prismaModule = path.join(fixture.root, 'gravity-mvp/src/lib/prisma.ts')
        await mkdir(path.dirname(prismaModule), { recursive: true })
        await writeFile(prismaModule, 'export const prisma = {}\n')
        await writeFile(index, [
            "import { prisma } from '@/lib/prisma'",
            "import OpenAI from 'openai'",
            'export const leakedPrisma = prisma',
            'export const leakedProvider = OpenAI',
            '',
        ].join('\n'))
        const violations = (await scanArchitecture(fixture.root)).findings.filter((finding) => (
            finding.rule === 'public_facade_implementation_laundering'
            && finding.file === 'gravity-mvp/src/modules/alpha/public/v1/index.ts'
        ))
        assert(violations.some((finding) => finding.subject === 'reachable-export-implementation:leakedPrisma'))
        assert(violations.some((finding) => finding.subject === 'reachable-export-implementation:leakedProvider'))
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('arbitrary public filenames cannot export a Prisma implementation handle', async () => {
    const fixture = await makeFixture()
    try {
        const client = path.join(fixture.root, 'gravity-mvp/src/modules/alpha/public/v1/client.ts')
        const prismaModule = path.join(fixture.root, 'gravity-mvp/src/lib/prisma.ts')
        await mkdir(path.dirname(prismaModule), { recursive: true })
        await writeFile(prismaModule, 'export const prisma = {}\n')
        await writeFile(client, [
            "import { prisma } from '@/lib/prisma'",
            'export const leakedClient = prisma',
            '',
        ].join('\n'))
        const violations = (await scanArchitecture(fixture.root)).findings.filter((finding) => (
            finding.rule === 'public_facade_implementation_laundering'
            && finding.file === 'gravity-mvp/src/modules/alpha/public/v1/client.ts'
        ))
        assert(violations.some((finding) => finding.subject === 'reachable-export-implementation:leakedClient'))
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('arbitrary public filenames reject provider-tainted local modules', async () => {
    const fixture = await makeFixture()
    try {
        const client = path.join(fixture.root, 'gravity-mvp/src/modules/alpha/public/v1/client.ts')
        const transport = path.join(fixture.root, 'gravity-mvp/src/modules/alpha/provider-transport.ts')
        await writeFile(client, "export { transport } from '../../provider-transport'\n")
        await writeFile(transport, 'export const transport = true\n')
        await writeJson(fixture.root, 'architecture/evidence/v1/provider-dependencies.json', {
            providers: [{ provider: 'openai', evidence: [{ file: 'gravity-mvp/src/modules/alpha/provider-transport.ts', match_kind: 'path' }] }],
        })
        const violations = (await scanArchitecture(fixture.root)).findings.filter((finding) => (
            finding.rule === 'public_facade_implementation_laundering'
            && finding.file === 'gravity-mvp/src/modules/alpha/public/v1/client.ts'
        ))
        assert(violations.some((finding) => finding.subject === 'reachable-export-implementation:transport'))
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('public facades inspect owner application composition transitively', async () => {
    const fixture = await makeFixture()
    try {
        const facade = path.join(fixture.root, 'gravity-mvp/src/modules/alpha/public/v1/facade.ts')
        const composition = path.join(fixture.root, 'gravity-mvp/src/modules/alpha/application/bridge.ts')
        await mkdir(path.dirname(composition), { recursive: true })
        await writeFile(facade, "export { executeV1 } from '../../application/bridge'\n")
        await writeFile(composition, [
            "import OpenAI from 'openai'",
            "export { secret as executeV1 } from '../internal/secret'",
            'export interface BridgeUnitOfWork { run(operation: unknown): Promise<void> }',
            'prisma.alphaRecord.update({ where: { id: 1 }, data: {} })',
            'void OpenAI',
            '',
        ].join('\n'))
        const violations = (await scanArchitecture(fixture.root)).findings.filter((finding) => (
            finding.rule === 'public_facade_implementation_laundering'
            && finding.file === 'gravity-mvp/src/modules/alpha/application/bridge.ts'
        ))
        assert(violations.some((finding) => finding.subject === 'transitive:composition-value-reexport'))
        assert(violations.some((finding) => finding.subject === 'transitive-write:alphaRecord.update'))
        assert(violations.some((finding) => finding.subject === 'transitive-implementation-import:openai'))
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('public facades reject nonliteral module loading while preserving literal wrappers', async () => {
    const fixture = await makeFixture()
    try {
        const facade = path.join(fixture.root, 'gravity-mvp/src/modules/alpha/public/v1/facade.ts')
        await writeFile(facade, "const internal = '../../internal/secret'\nexport const load = () => import(internal)\n")
        let scan = await scanArchitecture(fixture.root)
        assert.equal(scan.findings.some((finding) => (
            finding.rule === 'public_facade_internal_import'
            && finding.file === 'gravity-mvp/src/modules/alpha/public/v1/facade.ts'
            && finding.details?.reason === 'public facades must use statically resolvable module specifiers'
        )), true)
        await writeFile(facade, "export const load = () => import('./view')\n")
        scan = await scanArchitecture(fixture.root)
        assert.equal(scan.findings.some((finding) => (
            finding.rule === 'public_facade_internal_import'
            && finding.file === 'gravity-mvp/src/modules/alpha/public/v1/facade.ts'
        )), false)
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('public alias re-export cannot return an imported internal Prisma client', async () => {
    const fixture = await makeFixture()
    try {
        await writeFixtureFiles(fixture.root, {
            'gravity-mvp/src/modules/alpha/public/v1/facade.ts': "export { exposeClient as executeV1 } from '../../application/expose-client'\n",
            'gravity-mvp/src/modules/alpha/application/expose-client.ts': [
                "import { prisma } from '../internal/prisma-holder'",
                'export function exposeClient(): unknown { return prisma }',
                '',
            ].join('\n'),
            'gravity-mvp/src/modules/alpha/internal/prisma-holder.ts': "export { prisma } from '@/lib/prisma'\n",
            'gravity-mvp/src/lib/prisma.ts': 'export const prisma = { alphaRecord: {} }\n',
        })
        const leaks = reachablePublicLeaks(await scanArchitecture(fixture.root))
        assert(leaks.some((finding) => finding.file.endsWith('/facade.ts') && finding.subject.endsWith(':executeV1')))
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('public barrel hops cannot hide application exposure of internal Prisma', async () => {
    const fixture = await makeFixture()
    try {
        await writeFixtureFiles(fixture.root, {
            'gravity-mvp/src/modules/alpha/public/v1/facade.ts': "export { executeV1 } from './operations'\n",
            'gravity-mvp/src/modules/alpha/public/v1/operations.ts': "export { exposeClient as executeV1 } from '../../application/expose-client'\n",
            'gravity-mvp/src/modules/alpha/application/expose-client.ts': [
                "import { prisma } from '../internal/prisma-holder'",
                'export const exposeClient = (): unknown => prisma',
                '',
            ].join('\n'),
            'gravity-mvp/src/modules/alpha/internal/prisma-holder.ts': "export { prisma } from '@/lib/prisma'\n",
            'gravity-mvp/src/lib/prisma.ts': 'export const prisma = { alphaRecord: {} }\n',
        })
        const leaks = reachablePublicLeaks(await scanArchitecture(fixture.root))
        assert(leaks.some((finding) => finding.file.endsWith('/facade.ts') && finding.subject.endsWith(':executeV1')))
        assert(leaks.some((finding) => finding.file.endsWith('/operations.ts') && finding.subject.endsWith(':executeV1')))
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('application functions cannot expose a literal dynamic import of an internal module', async () => {
    const fixture = await makeFixture()
    try {
        await writeFixtureFiles(fixture.root, {
            'gravity-mvp/src/modules/alpha/public/v1/facade.ts': "export { revealV1 } from '../../application/dynamic-exposure'\n",
            'gravity-mvp/src/modules/alpha/application/dynamic-exposure.ts': "export function revealV1() { return import('../internal/concealed') }\n",
            'gravity-mvp/src/modules/alpha/internal/concealed.ts': "export { prisma } from '@/lib/prisma'\n",
            'gravity-mvp/src/lib/prisma.ts': 'export const prisma = { alphaRecord: {} }\n',
        })
        const leaks = reachablePublicLeaks(await scanArchitecture(fixture.root))
        assert(leaks.some((finding) => finding.file.endsWith('/facade.ts') && finding.subject.endsWith(':revealV1')))
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('application functions cannot return callbacks closing over internal Prisma', async () => {
    const fixture = await makeFixture()
    try {
        await writeFixtureFiles(fixture.root, {
            'gravity-mvp/src/modules/alpha/public/v1/facade.ts': "export { callbackV1 } from '../../application/callback-exposure'\n",
            'gravity-mvp/src/modules/alpha/application/callback-exposure.ts': [
                "import { prisma } from '../internal/prisma-holder'",
                'export function callbackV1() { return () => prisma }',
                '',
            ].join('\n'),
            'gravity-mvp/src/modules/alpha/internal/prisma-holder.ts': "export { prisma } from '@/lib/prisma'\n",
            'gravity-mvp/src/lib/prisma.ts': 'export const prisma = { alphaRecord: {} }\n',
        })
        const leaks = reachablePublicLeaks(await scanArchitecture(fixture.root))
        assert(leaks.some((finding) => finding.file.endsWith('/facade.ts') && finding.subject.endsWith(':callbackV1')))
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('application functions cannot return objects containing internal Prisma', async () => {
    const fixture = await makeFixture()
    try {
        await writeFixtureFiles(fixture.root, {
            'gravity-mvp/src/modules/alpha/public/v1/facade.ts': "export { objectV1 } from '../../application/object-exposure'\n",
            'gravity-mvp/src/modules/alpha/application/object-exposure.ts': [
                "import { prisma } from '../internal/prisma-holder'",
                'export const objectV1 = () => ({ client: prisma })',
                '',
            ].join('\n'),
            'gravity-mvp/src/modules/alpha/internal/prisma-holder.ts': "export { prisma } from '@/lib/prisma'\n",
            'gravity-mvp/src/lib/prisma.ts': 'export const prisma = { alphaRecord: {} }\n',
        })
        const leaks = reachablePublicLeaks(await scanArchitecture(fixture.root))
        assert(leaks.some((finding) => finding.file.endsWith('/facade.ts') && finding.subject.endsWith(':objectV1')))
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('application functions cannot expose provider clients imported through internal modules', async () => {
    const fixture = await makeFixture()
    try {
        await writeFixtureFiles(fixture.root, {
            'gravity-mvp/src/modules/alpha/public/v1/facade.ts': "export { providerV1 } from '../../application/provider-exposure'\n",
            'gravity-mvp/src/modules/alpha/application/provider-exposure.ts': [
                "import { openAiClient } from '../internal/provider-client'",
                'export const providerV1 = (): unknown => openAiClient',
                '',
            ].join('\n'),
            'gravity-mvp/src/modules/alpha/internal/provider-client.ts': "import OpenAI from 'openai'\nexport const openAiClient = new OpenAI()\n",
        })
        const leaks = reachablePublicLeaks(await scanArchitecture(fixture.root))
        assert(leaks.some((finding) => finding.file.endsWith('/facade.ts') && finding.subject.endsWith(':providerV1')))
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('narrow owner composition may call an internal implementation and return a business DTO', async () => {
    const fixture = await makeFixture()
    try {
        await writeFixtureFiles(fixture.root, {
            'gravity-mvp/src/modules/alpha/public/v1/facade.ts': "export { executeV1 } from '../../application/execute'\n",
            'gravity-mvp/src/modules/alpha/application/execute.ts': [
                "import { executeWithPrisma } from '../internal/prisma-adapter'",
                'export interface ResultV1 { readonly id: string }',
                'export async function executeV1(id: string, onReady?: (result: ResultV1) => void): Promise<ResultV1> {',
                '  await executeWithPrisma(id)',
                '  const result = { id }',
                '  onReady?.(result)',
                '  return result',
                '}',
                '',
            ].join('\n'),
            'gravity-mvp/src/modules/alpha/internal/prisma-adapter.ts': [
                "import { prisma } from '@/lib/prisma'",
                'export async function executeWithPrisma(id: string): Promise<void> {',
                '  await prisma.alphaRecord.update({ where: { id }, data: {} })',
                '}',
                '',
            ].join('\n'),
            'gravity-mvp/src/lib/prisma.ts': 'export const prisma = { alphaRecord: { update: async (_input: unknown) => undefined } }\n',
        })
        const scan = await scanArchitecture(fixture.root)
        assert.equal(reachablePublicLeaks(scan).length, 0)
        assert.equal(scan.findings.some((finding) => (
            finding.rule === 'public_facade_implementation_laundering'
            && finding.details?.public_source === 'gravity-mvp/src/modules/alpha/public/v1/facade.ts'
        )), false)
    } finally {
        await rm(fixture.root, { recursive: true, force: true })
    }
})

test('public closure rejects argument, receiver, mutation, runtime-name, CommonJS, class, and filename laundering', async () => {
    const fixture = await makeFixture()
    try {
        await writeFixtureFiles(fixture.root, {
            'gravity-mvp/src/modules/alpha/public/v1/facade.ts': [
                "export { promiseV1, passV1, defaultV1, dynamicV1, proxyV1, assignV1, defineV1, destructuringV1, callbackEscapeV1, callbackClosureV1, callbackWrappedV1, rejectionV1, generatorV1, prototypeV1, prototypeAliasV1, prototypeWrappedV1, moduleRequireV1, classV1, repositoryV1 } from '../../application/laundering'",
                "export { prisma as cjsPrisma } from './evil.cjs'",
                '',
            ].join('\n'),
            'gravity-mvp/src/modules/alpha/application/laundering.ts': [
                "import { prisma } from '../internal/prisma-holder'",
                'const pass = <T>(value: T) => value',
                'export const promiseV1 = () => Promise.resolve(prisma)',
                'export const passV1 = () => pass(prisma)',
                'export function defaultV1(client = prisma) { return client }',
                "export const dynamicV1 = () => import('../internal/prisma-holder').then((loaded) => loaded.prisma)",
                'export const proxyV1 = () => new Proxy(prisma, {})',
                'export const assignV1 = () => { const result = {}; Object.assign(result, { client: prisma }); return result }',
                "export const defineV1 = () => { const result = {}; Object.defineProperty(result, 'client', { value: prisma }); return result }",
                'export const destructuringV1 = () => { let leaked; ({ client: leaked } = { client: prisma }); return leaked }',
                'export const callbackEscapeV1 = (callback: (value: unknown) => void) => { callback(prisma); return { ok: true } }',
                'export const callbackClosureV1 = (callback: (value: unknown) => void) => { const bound = callback.bind(undefined); const leak = () => bound(prisma); leak(); return { ok: true } }',
                'const invokeCallback = (callback: (value: unknown) => void, value: unknown) => callback(value)',
                'export const callbackWrappedV1 = (callback: (value: unknown) => void) => { invokeCallback(callback, prisma); return { ok: true } }',
                'export async function rejectionV1() { throw prisma }',
                'export function* generatorV1() { yield prisma }',
                'export const prototypeV1 = () => { const result = {}; Object.setPrototypeOf(result, prisma); return result }',
                'const setPrototype = Reflect.setPrototypeOf',
                'export const prototypeAliasV1 = () => { const result = {}; setPrototype(result, prisma); return result }',
                'const wrapSetPrototype = (target: object, prototype: object) => Object.setPrototypeOf(target, prototype)',
                'export const prototypeWrappedV1 = () => { const result = {}; wrapSetPrototype(result, prisma); return result }',
                "const requiredPrisma = module.require('@/lib/prisma')",
                'export const moduleRequireV1 = () => requiredPrisma',
                'export const classV1 = class { static client = prisma }',
                'export const repositoryV1 = { execute: () => ({ id: "safe-looking" }) }',
                '',
            ].join('\n'),
            'gravity-mvp/src/modules/alpha/public/v1/innocent.ts': [
                "import { prisma } from '@/lib/prisma'",
                'export async function narrowWriteV1(id: string) {',
                '  await prisma.alphaRecord.update({ where: { id }, data: {} })',
                '  return { id }',
                '}',
                '',
            ].join('\n'),
            'gravity-mvp/src/modules/beta/public/v1/consumer.ts': "import { narrowWriteV1 } from '../../../alpha/public/v1/innocent'\nvoid narrowWriteV1\n",
            'gravity-mvp/src/modules/alpha/public/v1/evil.cjs': [
                "const { createRequire } = require('node:module')",
                'const localRequire = createRequire(__filename)',
                "const { prisma } = localRequire('@/lib/prisma')",
                'module.exports = { prisma }',
                '',
            ].join('\n'),
            'gravity-mvp/src/modules/alpha/internal/prisma-holder.ts': "export { prisma } from '@/lib/prisma'\n",
            'gravity-mvp/src/lib/prisma.ts': 'export const prisma = { alphaRecord: { update: async (_input: unknown) => undefined } }\n',
        })
        const scan = await scanArchitecture(fixture.root)
        const facadeFindings = scan.findings.filter((finding) => (
            finding.rule === 'public_facade_implementation_laundering'
            && finding.file === 'gravity-mvp/src/modules/alpha/public/v1/facade.ts'
            && finding.subject.startsWith('reachable-export-implementation:')
        ))
        for (const name of [
            'promiseV1', 'passV1', 'defaultV1', 'dynamicV1', 'proxyV1', 'assignV1', 'defineV1',
            'destructuringV1', 'callbackEscapeV1', 'callbackClosureV1', 'callbackWrappedV1', 'rejectionV1', 'generatorV1',
            'prototypeV1', 'prototypeAliasV1', 'prototypeWrappedV1', 'moduleRequireV1', 'classV1', 'repositoryV1', 'cjsPrisma',
        ]) assert(facadeFindings.some((finding) => finding.subject.endsWith(`:${name}`)), `expected laundering finding for ${name}`)
        assert.equal(scan.findings.some((finding) => (
            finding.rule === 'internal_module_import'
            && finding.file.endsWith('/beta/public/v1/consumer.ts')
            && finding.subject.includes('/alpha/public/v1/innocent.ts')
        )), false, 'a fixed-point-proven narrow business operation may attenuate its private Prisma binding for a cross-context caller')

        await writeFile(path.join(fixture.root, 'gravity-mvp/src/modules/alpha/public/v1/commonjs-view.cjs'), 'module.exports = { view: true }\n')
        const commonJsScan = await scanArchitecture(fixture.root)
        assert(commonJsScan.findings.some((finding) => (
            finding.rule === 'public_facade_implementation_laundering'
            && finding.file.endsWith('/commonjs-view.cjs')
            && finding.subject === 'public-commonjs-export-assignment'
        )))
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
        'public_facade_internal_import',
        'public_facade_implementation_laundering',
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
