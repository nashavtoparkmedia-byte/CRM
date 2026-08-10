#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { analyzeSqlMutation, analyzeSqlScript, tokenizeSql } from './sql-mutation-analyzer.mjs'
import { analyzePrismaWriteSites, extractPrismaWrites } from './write-analyzer.mjs'

const tests = []

function test(name, body) {
    tests.push({ name, body })
}

function compact(sites) {
    return sites.map((site) => ({
        kind: site.kind,
        model: site.model,
        method: site.method,
        ambiguous: site.ambiguous,
        candidate_models: site.candidate_models,
    }))
}

test('SQL tokenizer hides comments, values and dollar-quoted bodies', () => {
    const tokens = tokenizeSql([
        "SELECT 'DELETE FROM hidden_string'",
        '-- UPDATE hidden_line SET x = 1',
        '/* INSERT INTO hidden_block VALUES (1) */',
        'DO $$ BEGIN DELETE FROM hidden_body; END $$;',
        'DELETE FROM visible_table WHERE note = \'UPDATE hidden_value\'',
    ].join('\n'))
    const words = tokens.filter((token) => token.kind === 'word').map((token) => token.value.toUpperCase())
    assert.equal(words.filter((word) => word === 'DELETE').length, 1)
    assert(words.includes('VISIBLE_TABLE'))
})

test('SQL analyzer extracts DML, schema qualification and table lists', () => {
    const result = analyzeSqlScript([
        'INSERT INTO public.alpha_table (id) VALUES (1);',
        'UPDATE other.beta_table SET x = 1;',
        'DELETE FROM gamma_table WHERE id = 1;',
        'MERGE INTO delta_table USING source_table ON true WHEN MATCHED THEN DELETE;',
        'TRUNCATE TABLE epsilon_table, public.zeta_table;',
    ].join('\n'))
    assert.equal(result.is_mutation, true)
    assert.equal(result.ambiguous, false)
    assert.deepEqual(result.operations.map((item) => item.operation), [
        'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'TRUNCATE',
    ])
    assert.deepEqual(result.tables, [
        'alpha_table', 'delta_table', 'epsilon_table', 'gamma_table', 'other.beta_table', 'zeta_table',
    ])
})

test('SQL analyzer extracts bounded DDL targets', () => {
    const result = analyzeSqlMutation([
        'CREATE TABLE IF NOT EXISTS one_table (id text);',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_one ON one_table (id);',
        'ALTER TABLE IF EXISTS public.two_table ADD COLUMN x int;',
        'DROP TABLE IF EXISTS three_table, public.four_table;',
    ].join('\n'))
    assert.deepEqual(result.operations.map((item) => item.operation), [
        'CREATE_TABLE', 'CREATE_INDEX', 'ALTER_TABLE', 'DROP_TABLE', 'DROP_TABLE',
    ])
    assert.deepEqual(result.tables, ['four_table', 'one_table', 'three_table', 'two_table'])
})

test('SQL analyzer retains non-table schema mutations used by migrations', () => {
    const result = analyzeSqlMutation([
        'CREATE TYPE mood AS ENUM (\'ok\');',
        'ALTER TYPE mood ADD VALUE \'great\';',
        'CREATE VIEW contact_view AS SELECT 1 AS id;',
        'CREATE FUNCTION touch_contact() RETURNS void LANGUAGE SQL AS \'SELECT 1\';',
        'DROP INDEX IF EXISTS idx_contact;',
        'REFRESH MATERIALIZED VIEW CONCURRENTLY contact_rollup;',
    ].join('\n'))
    assert.deepEqual(result.operations.map((item) => item.operation), [
        'CREATE_TYPE', 'ALTER_TYPE', 'CREATE_VIEW', 'CREATE_FUNCTION',
        'DROP_INDEX', 'REFRESH_MATERIALIZED_VIEW',
    ])
    assert.equal(result.is_mutation, true)
})

test('SQL analyzer opens executable DO blocks and retains CALL/COPY/function ambiguity', () => {
    const procedural = analyzeSqlMutation([
        'DO $$ BEGIN INSERT INTO "Chat" (id) VALUES (1); DELETE FROM "Message"; END $$;',
        'COPY public.contacts FROM STDIN;',
        'CALL rebuild_driver_rollups();',
    ].join('\n'))
    assert.equal(procedural.is_mutation, true)
    assert(procedural.tables.includes('Chat'))
    assert(procedural.tables.includes('Message'))
    assert(procedural.tables.includes('contacts'))
    assert(procedural.operations.some((operation) => operation.operation === 'CALL'))
    assert.equal(procedural.ambiguous, true)

    const functionSelect = analyzeSqlMutation('SELECT mutating_function()')
    assert.equal(functionSelect.is_mutation, null)
    assert.equal(functionSelect.ambiguous, true)
    assert(functionSelect.reasons.includes('select_function_side_effect_unresolved'))
})

test('SQL ONLY modifiers never become confident table identities', () => {
    const result = analyzeSqlMutation([
        'INSERT INTO ONLY one_table (id) VALUES (1);',
        'UPDATE ONLY two_table SET id = 2;',
        'DELETE FROM ONLY three_table;',
        'TRUNCATE TABLE ONLY four_table;',
    ].join('\n'))
    assert.deepEqual(result.tables, ['four_table', 'one_table', 'three_table', 'two_table'])
    assert.equal(result.ambiguous, false)
})

test('SELECT FOR UPDATE and referential ON UPDATE are not mutations', () => {
    const select = analyzeSqlMutation('SELECT id FROM "Driver" WHERE id = $1 FOR UPDATE')
    const constraint = analyzeSqlMutation('SELECT \'ON UPDATE CASCADE\'; -- UPDATE fake SET x=1')
    assert.equal(select.is_mutation, false)
    assert.equal(constraint.is_mutation, false)
})

test('ON CONFLICT DO UPDATE remains one INSERT target', () => {
    const result = analyzeSqlMutation('INSERT INTO one_table (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1')
    assert.deepEqual(result.operations.map((item) => [item.operation, item.table]), [['INSERT', 'one_table']])
})

test('REPLACE is DML only at statement position', () => {
    const scalar = analyzeSqlMutation("SELECT replace(name, 'a', 'b') FROM users")
    assert.equal(scalar.is_mutation, false)
    const ddl = analyzeSqlMutation([
        "CREATE OR REPLACE FUNCTION touch_user() RETURNS void LANGUAGE SQL AS 'SELECT 1';",
        'CREATE OR REPLACE VIEW current_users AS SELECT * FROM users;',
        'INSERT OR REPLACE INTO users (id) VALUES (1);',
        'REPLACE INTO accounts (id) VALUES (1);',
    ].join('\n'))
    assert.deepEqual(ddl.operations.map((item) => [item.operation, item.table ?? item.object]), [
        ['CREATE_FUNCTION', 'touch_user'],
        ['CREATE_VIEW', 'current_users'],
        ['INSERT', 'users'],
        ['REPLACE', 'accounts'],
    ])
})

test('trigger events and privileges never become false UPDATE table targets', () => {
    const result = analyzeSqlMutation([
        'CREATE TRIGGER audit_update AFTER UPDATE ON users EXECUTE FUNCTION audit_user();',
        'GRANT UPDATE ON TABLE users TO app;',
        'REVOKE UPDATE ON TABLE users FROM app;',
    ].join('\n'))
    assert.equal(result.operations.filter((item) => item.operation === 'UPDATE').length, 0)
    assert.equal(result.tables.includes('ON'), false)
    assert.deepEqual(result.operations.map((item) => item.operation), ['CREATE_TRIGGER', 'GRANT', 'REVOKE'])
})

test('policy and comment DDL remain ownership-visible', () => {
    const result = analyzeSqlMutation([
        'CREATE POLICY tenant_read ON users USING (true);',
        'ALTER POLICY tenant_read ON users USING (false);',
        'DROP POLICY IF EXISTS tenant_read ON users;',
        "COMMENT ON TABLE users IS 'owner metadata';",
    ].join('\n'))
    assert.deepEqual(result.operations.map((item) => item.operation), [
        'CREATE_POLICY', 'ALTER_POLICY', 'DROP_POLICY', 'COMMENT_TABLE',
    ])
    assert.deepEqual(result.tables, ['users'])
})

test('dialect and ONLY modifiers cannot become table names', () => {
    const result = analyzeSqlMutation([
        'UPDATE OR REPLACE users SET name = 1;',
        'UPDATE LOW_PRIORITY IGNORE accounts SET active = 1;',
        'DELETE users FROM users JOIN accounts ON true;',
        'TRUNCATE TABLE one, ONLY two;',
        'ALTER TABLE IF EXISTS ONLY three ADD COLUMN x int;',
        'DROP TABLE IF EXISTS ONLY four;',
        'DROP INDEX CONCURRENTLY IF EXISTS idx_users;',
    ].join('\n'))
    assert.equal(result.tables.includes('OR'), false)
    assert.equal(result.tables.includes('ONLY'), false)
    assert.equal(result.tables.includes('LOW_PRIORITY'), false)
    assert(result.tables.includes('users'))
    assert(result.tables.includes('accounts'))
    assert(result.tables.includes('one'))
    assert(result.tables.includes('two'))
    assert(result.operations.some((item) => item.operation === 'DELETE_MULTI'))
    assert.equal(result.ambiguous, true)
})

test('dynamic or malformed SQL targets remain explicit ambiguity', () => {
    const result = analyzeSqlMutation('DELETE FROM __YOKO_DYNAMIC_SQL__ WHERE id = 1')
    assert.equal(result.is_mutation, true)
    assert.equal(result.ambiguous, true)
    assert.deepEqual(result.tables, [])
    assert(result.reasons.includes('unresolved_mutation_target'))
})

test('extracts every declared Prisma model write method', () => {
    const source = [
        'prisma.a.create({})',
        'prisma.b.createMany({})',
        'prisma.c.createManyAndReturn({})',
        'prisma.d.update({})',
        'prisma.e.updateMany({})',
        'prisma.f.upsert({})',
        'prisma.g.delete({})',
        'prisma.h.deleteMany({})',
    ].join('\n')
    assert.deepEqual(extractPrismaWrites(source).map((site) => site.method), [
        'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany',
    ])
})

test('unwraps delegate/client casts, parentheses, non-null and optional chains', () => {
    const sites = extractPrismaWrites([
        '(prisma.chat as any).create({});',
        '(((prisma.message as unknown) as any)!).updateMany({});',
        '(prisma as any).contact.delete({});',
        'prisma.task?.upsert({});',
        "prisma['driver']['deleteMany']({});",
    ].join('\n'))
    assert.deepEqual(compact(sites), [
        { kind: 'model', model: 'chat', method: 'create', ambiguous: false, candidate_models: ['chat'] },
        { kind: 'model', model: 'message', method: 'updateMany', ambiguous: false, candidate_models: ['message'] },
        { kind: 'model', model: 'contact', method: 'delete', ambiguous: false, candidate_models: ['contact'] },
        { kind: 'model', model: 'task', method: 'upsert', ambiguous: false, candidate_models: ['task'] },
        { kind: 'model', model: 'driver', method: 'deleteMany', ambiguous: false, candidate_models: ['driver'] },
    ])
})

test('resolves imported clients, client aliases, delegate aliases and destructuring', () => {
    const sites = extractPrismaWrites([
        "import { prisma as rootClient } from '@/lib/prisma'",
        'const clientAlias = rootClient',
        'const chatDelegate = clientAlias.chat',
        'const { message: messages } = clientAlias',
        'chatDelegate.update({})',
        'messages.create({})',
    ].join('\n'))
    assert.deepEqual(sites.map((site) => [site.model, site.method]), [
        ['chat', 'update'], ['message', 'create'],
    ])
    assert(sites.every((site) => site.confidence === 'HIGH'))
})

test('resolves statically bound Prisma operation aliases', () => {
    const sites = extractPrismaWrites([
        'const createChat = prisma.chat.create',
        'const { update: updateMessage } = prisma.message',
        'createChat({})',
        'updateMessage({})',
    ].join('\n'))
    assert.deepEqual(sites.map((site) => [site.model, site.method]), [
        ['chat', 'create'], ['message', 'update'],
    ])
})

test('resolves dynamic-import destructuring and new PrismaClient aliases', () => {
    const sites = extractPrismaWrites([
        "const { prisma: imported } = await import('@/lib/prisma')",
        "const { PrismaClient } = require('@prisma/client')",
        'const database = new PrismaClient()',
        'imported.chat.update({})',
        'database.message.create({})',
    ].join('\n'), { fileName: 'fixture.mjs' })
    assert.deepEqual(sites.map((site) => [site.model, site.method]), [
        ['chat', 'update'], ['message', 'create'],
    ])
})

test('resolves renamed ESM/CJS constructors, destructuring assignment and nested holders', () => {
    const sites = extractPrismaWrites([
        "import { PrismaClient as Client } from '@prisma/client'",
        "const { PrismaClient: CjsClient } = require('@prisma/client')",
        'const esm = new Client()',
        'const cjs = new CjsClient()',
        'let chat, message',
        '({ chat } = esm)',
        '({ nested: { message } } = { nested: cjs })',
        'const holder = { delegates: [chat, message] }',
        'holder.delegates[0].create({})',
        'holder.delegates[1].update({})',
    ].join('\n'))
    assert.deepEqual(sites.map((site) => [site.model, site.method]), [
        ['chat', 'create'], ['message', 'update'],
    ])
})

test('resolves destructured transaction callbacks, helper returns, bind and comma sequences', () => {
    const sites = extractPrismaWrites([
        'const identity = (value) => value',
        'function chats() { return prisma.chat }',
        'const createMessage = prisma.message.create.bind(prisma.message)',
        'chats().update({})',
        'createMessage({})',
        'identity((0, prisma.task)).delete({})',
        'prisma.$transaction(async ({ driver }) => { driver.upsert({}) })',
    ].join('\n'))
    assert.deepEqual(sites.map((site) => [site.model, site.method]), [
        ['chat', 'update'], ['message', 'create'], ['task', 'delete'], ['driver', 'upsert'],
    ])
    assert.equal(sites[3].transaction.contained, true)
})

test('resolves parameterized delegate helpers and externally declared transaction callbacks', () => {
    const sites = extractPrismaWrites([
        'const delegate = (client) => client.chat',
        'const work = async (tx) => { tx.message.update({}) }',
        'delegate(prisma).create({})',
        'prisma.$transaction(work)',
    ].join('\n'))
    assert.deepEqual(sites.map((site) => [site.model, site.method]), [
        ['message', 'update'], ['chat', 'create'],
    ])
    assert.equal(sites[0].transaction.contained, true)
})

test('helper control flow never creates false owner certainty or hides candidates', () => {
    const shadowed = extractPrismaWrites([
        'const ordinary = { create() {} }',
        'function pick(value) { { const value = ordinary; return value } }',
        'pick(prisma.chat).create({})',
    ].join('\n'))
    assert.deepEqual(shadowed, [])

    const branched = extractPrismaWrites([
        'function pick(flag) { if (flag) return prisma.chat; return ordinary }',
        'pick(flag).create({})',
    ].join('\n'))
    assert.equal(branched.length, 1)
    assert.equal(branched[0].kind, 'ambiguous_model')
    assert.deepEqual(branched[0].candidate_models, ['chat'])
})

test('logical assignment aliases remain explicit ambiguity', () => {
    const sites = extractPrismaWrites('let delegate; delegate ??= prisma.chat; delegate.create({})')
    assert.equal(sites.length, 1)
    assert.equal(sites[0].ambiguous, true)
    assert(sites[0].ambiguity_reasons.includes('conditional_assignment'))
})

test('resolves one dominating delegate assignment and rejects reassignment certainty', () => {
    const sites = extractPrismaWrites([
        'let stable',
        'stable = prisma.chat',
        'stable.update({})',
        'let changed',
        'changed = prisma.chat',
        'changed = prisma.message',
        'changed.deleteMany({})',
    ].join('\n'))
    assert.equal(sites[0].kind, 'model')
    assert.deepEqual([sites[0].model, sites[0].method], ['chat', 'update'])
    assert.equal(sites[1].kind, 'ambiguous_model')
    assert(sites[1].ambiguity_reasons.includes('delegate_reassigned'))
})

test('transaction callback aliases and array writes are annotated', () => {
    const sites = extractPrismaWrites([
        'await prisma.$transaction(async (unit) => {',
        '  const { chat: chats } = unit',
        '  await (chats as any).create({})',
        '})',
        'await prisma.$transaction([prisma.message.update({}), prisma.task.delete({})])',
    ].join('\n'))
    assert.deepEqual(sites.map((site) => [site.model, site.method]), [
        ['chat', 'create'], ['message', 'update'], ['task', 'delete'],
    ])
    assert(sites.every((site) => site.transaction.contained))
})

test('conditional delegates and dynamic delegate/operation access are ambiguous', () => {
    const sites = extractPrismaWrites([
        'const selected = choose ? prisma.chat : prisma.message',
        'selected.update({})',
        'prisma[modelName].create({})',
        'prisma.chat[operationName]({})',
        'prisma[modelName][operationName]({})',
    ].join('\n'))
    assert.equal(sites.length, 4)
    assert(sites.every((site) => site.kind === 'ambiguous_model'))
    assert.deepEqual(sites[0].candidate_models, ['chat', 'message'])
    assert.equal(sites[0].method, 'update')
    assert(sites.slice(1).every((site) => site.ambiguity_reasons.length > 0))
})

test('does not mistake ordinary create methods, comments or strings for Prisma writes', () => {
    const source = [
        'const repository = { create() {} }',
        'repository.create()',
        'const prisma = { chat: { create() {} } }',
        'prisma.chat.create()',
        '// prisma.chat.delete({})',
        'const sample = "prisma.message.update({})"',
        'database.user.create({})',
    ].join('\n')
    assert.deepEqual(extractPrismaWrites(source), [])
})

test('unproven request and class prisma members are ambiguity, not false certainty', () => {
    const sites = extractPrismaWrites([
        'req.prisma.bot.create({})',
        'this.prisma.survey.update({})',
        'db.answer.delete({})',
    ].join('\n'))
    assert.deepEqual(sites.map((site) => [site.kind, site.model, site.method, site.confidence]), [
        ['ambiguous_model', null, 'create', 'CONSERVATIVE'],
        ['ambiguous_model', null, 'update', 'CONSERVATIVE'],
    ])
    assert(sites.every((site) => site.ambiguity_reasons.includes('unproven_prisma_member')))
})

test('untyped Prisma-named dependency injection is fail-closed ambiguity', () => {
    const sites = extractPrismaWrites([
        'function direct(prisma) { prisma.user.create({}) }',
        'function alias(prismaClient) { prismaClient.message.update({}) }',
        'function destructured({ prisma }) { prisma.chat.delete({}) }',
        'function nested({ services: { prisma: { task } } }) { task.upsert({}) }',
    ].join('\n'))
    assert.equal(sites.length, 4)
    assert(sites.every((site) => site.ambiguous))
    assert(sites.every((site) => site.ambiguity_reasons.includes('unproven_prisma_dependency_injection')))
})

test('computed local require paths retaining @prisma/client are conservative clients', () => {
    const sites = extractPrismaWrites([
        "const path = require('node:path')",
        "const { PrismaClient } = require(path.join(__dirname, '../node_modules/@prisma/client'))",
        'const database = new PrismaClient()',
        'database.call.create({})',
        "const { PrismaClient: SplitClient } = require(path.join(__dirname, 'node_modules', '@prisma', 'client'))",
        'const split = new SplitClient()',
        'split.message.delete({})',
    ].join('\n'), { fileName: 'fixture.cjs' })
    assert.deepEqual(sites.map((site) => [site.model, site.method]), [
        ['call', 'create'], ['message', 'delete'],
    ])
})

test('a user-defined PrismaClient class is not treated as the imported ORM', () => {
    const sites = extractPrismaWrites('class PrismaClient {}; const local = new PrismaClient(); local.chat.create({})')
    assert.deepEqual(sites, [])
})

test('raw execute calls and tagged templates retain targets and ambiguity', () => {
    const sites = extractPrismaWrites([
        'const SQL = `UPDATE alpha_table SET x = 1`',
        'await prisma.$executeRawUnsafe(SQL)',
        'await prisma.$executeRaw`DELETE FROM beta_table WHERE id = ${id}`',
    ].join('\n'))
    assert.deepEqual(sites.map((site) => [site.method, site.tables]), [
        ['$executeRawUnsafe', ['alpha_table']],
        ['$executeRaw', ['beta_table']],
    ])
    assert.equal(sites[0].ambiguous, false)
    assert.equal(sites[1].ambiguous, true)
    assert(sites[1].ambiguity_reasons.includes('dynamic_sql_fragment'))
})

test('typed scalar Prisma template values do not create structural SQL ambiguity', () => {
    const sites = extractPrismaWrites([
        'async function remove(id: string) {',
        '  return prisma.$executeRaw`DELETE FROM beta_table WHERE id = ${id}`',
        '}',
    ].join('\n'))
    assert.equal(sites.length, 1)
    assert.equal(sites[0].ambiguous, false)
    assert.deepEqual(sites[0].tables, ['beta_table'])
})

test('mutation-bearing queryRaw is a write but SELECT FOR UPDATE is not', () => {
    const sites = extractPrismaWrites([
        'await prisma.$queryRaw`SELECT id FROM "Driver" FOR UPDATE`',
        'await prisma.$queryRaw`DELETE FROM "Message" WHERE id = ${id}`',
        'await prisma.$queryRaw`WITH removed AS (DELETE FROM "Chat" RETURNING id) SELECT * FROM removed`',
    ].join('\n'))
    assert.equal(sites.length, 2)
    assert.deepEqual(sites.map((site) => site.tables), [['Message'], ['Chat']])
    assert(sites.every((site) => site.method === '$queryRaw'))
})

test('explicit raw fragment in queryRaw is retained as ambiguous intent', () => {
    const sites = extractPrismaWrites('await prisma.$queryRaw`SELECT id FROM "Driver" WHERE ${Prisma.raw(possiblySql)}`')
    assert.equal(sites.length, 1)
    assert.equal(sites[0].ambiguous, true)
    assert(sites[0].ambiguity_reasons.includes('query_raw_dynamic_intent_unresolved'))
})

test('CALL, COPY, DO and SELECT function queryRaw calls never disappear', () => {
    const sites = extractPrismaWrites([
        "prisma.$queryRawUnsafe('CALL refresh_projection()')",
        "prisma.$queryRawUnsafe('COPY contacts FROM STDIN')",
        "prisma.$queryRawUnsafe('DO $$ BEGIN DELETE FROM contacts; END $$')",
        "prisma.$queryRawUnsafe('SELECT mutating_function()')",
    ].join('\n'))
    assert.equal(sites.length, 4)
    assert(sites.every((site) => site.ambiguous || site.operations.length > 0))
})

test('transaction containment follows the transaction client, not lexical nesting', () => {
    const sites = extractPrismaWrites([
        'prisma.$transaction(async (tx) => {',
        '  prisma.chat.create({})',
        '  setTimeout(() => prisma.message.create({}), 1)',
        '  tx.task.create({})',
        '})',
    ].join('\n'))
    assert.deepEqual(sites.map((site) => site.transaction.contained), [false, false, true])
})

test('generic SQLite-style mutation calls are retained without claiming Prisma', () => {
    const sites = extractPrismaWrites([
        'class Database {',
        '  run(sql) { return this.db.run(sql) }',
        "  remove() { return this.run('DELETE FROM users') }",
        '}',
    ].join('\n'), { fileName: 'database.js' })
    assert.equal(sites.length, 2)
    assert.equal(sites[0].method, 'sql-driver:run')
    assert.equal(sites[0].ambiguous, true)
    assert.deepEqual(sites[1].tables, ['users'])
})

test('Drizzle writes resolve typed clients, schema targets and transactions', () => {
    const sites = extractPrismaWrites([
        "import { accounts, activityLog, crmOutboxEvents, type Database } from '@avito/db'",
        'class Worker {',
        '  constructor(private readonly db: Database) {}',
        '  async run() {',
        '    await this.db.update(accounts).set({ active: true })',
        '    await this.db.insert(activityLog).values({})',
        '    await this.db.transaction(async (tx) => { tx.delete(crmOutboxEvents).where(true) })',
        '  }',
        '}',
    ].join('\n'))
    assert.deepEqual(sites.map((site) => [site.kind, site.model, site.method]), [
        ['drizzle', 'accounts', 'update'],
        ['drizzle', 'activityLog', 'insert'],
        ['drizzle', 'crmOutboxEvents', 'delete'],
    ])
    assert.equal(sites[2].transaction.contained, true)
})

test('unproven Drizzle DI is ambiguity while ordinary collection writes stay absent', () => {
    const sites = extractPrismaWrites([
        "import { responses } from '@avito/db'",
        'function persist(db) { db.insert(responses).values({}) }',
        'const accountId = "a"',
        'const contexts = new Map()',
        'contexts.delete(accountId)',
        'const ordinary = { update() {} }',
        'ordinary.update(accounts)',
    ].join('\n'))
    assert.equal(sites.length, 1)
    assert.equal(sites[0].model, 'responses')
    assert.equal(sites[0].ambiguous, true)
    assert(sites[0].ambiguity_reasons.includes('unproven_drizzle_receiver'))
})

test('Drizzle aliases resolve and dynamic targets or methods fail closed', () => {
    const sites = extractPrismaWrites([
        "import * as schema from '@avito/db'",
        "import { accounts, type Database } from '@avito/db'",
        'function persist(db: Database, table: unknown, operation: string) {',
        '  const alias = accounts',
        "  const boundedMethod = 'update' as const",
        '  db.update(alias).set({})',
        '  db.update(schema.accounts).set({})',
        '  db[boundedMethod](accounts).set({})',
        '  db.update(table)',
        '  db[operation](accounts)',
        '}',
    ].join('\n'))
    assert.deepEqual(sites.slice(0, 3).map((site) => [site.kind, site.model, site.method]), [
        ['drizzle', 'accounts', 'update'],
        ['drizzle', 'accounts', 'update'],
        ['drizzle', 'accounts', 'update'],
    ])
    assert(sites[3].ambiguity_reasons.includes('dynamic_drizzle_table'))
    assert(sites[4].ambiguity_reasons.includes('dynamic_drizzle_operation'))
})

test('ordinary run methods are not misclassified as database writes', () => {
    const sites = extractPrismaWrites("const animation = { run() {} }; animation.run('DELETE FROM visual_cache')")
    assert.deepEqual(sites, [])
})

test('nested relation-shaped mutations are fail-closed until schema resolution', () => {
    const sites = extractPrismaWrites('prisma.contact.update({ data: { chats: { create: { id: 1 } } } })')
    assert.equal(sites.length, 1)
    assert.equal(sites[0].ambiguous, true)
    assert.equal(sites[0].nested_operations[0].relation_field, 'chats')
    assert(sites[0].ambiguity_reasons.includes('nested_relation_write_requires_schema_resolution'))
})

test('Prisma SQL fragments and aliases cannot hide foreign raw targets', () => {
    const sites = extractPrismaWrites([
        "const fragment = Prisma.raw",
        "function wrapped() { return Prisma.sql`DELETE FROM foreign_two` }",
        'prisma.$executeRaw`DELETE FROM local_table WHERE ${Prisma.sql`DELETE FROM foreign_one`}`',
        "prisma.$executeRaw`UPDATE local_table SET x = ${fragment('DELETE FROM foreign_three')}`",
        'prisma.$executeRaw`UPDATE local_table SET x = ${wrapped()}`',
    ].join('\n'))
    assert.equal(sites.length, 3)
    assert(sites.every((site) => site.ambiguous))
    assert(sites[0].tables.includes('foreign_one'))
    assert(sites[1].tables.includes('foreign_three'))
    assert(sites[2].tables.includes('foreign_two'))
})

test('unknown raw SQL remains explicit rather than disappearing', () => {
    const sites = extractPrismaWrites([
        'await prisma.$executeRawUnsafe(runtimeSql)',
        'await prisma.$queryRawUnsafe(runtimeMaybeReadOrWrite)',
    ].join('\n'))
    assert.equal(sites.length, 2)
    assert(sites.every((site) => site.ambiguous))
    assert(sites[1].ambiguity_reasons.includes('query_raw_intent_unresolved'))
})

test('optional read inventory records public projections and full-row credential risk', () => {
    const result = analyzePrismaWriteSites([
        'prisma.apiConnection.findMany()',
        'prisma.telegramConnection.findFirst({ select: { id: true, apiHash: true } })',
        'const safeOmit = { sessionData: true }',
        'prisma.whatsAppConnection.findUnique({ omit: safeOmit })',
        'prisma.maxConnection.count()',
        'prisma.$queryRaw`SELECT "apiKey" FROM "ApiConnection"`',
        'prisma.$queryRaw`SELECT * FROM "Bot"`',
    ].join('\n'), { includeReads: true, includeRawReads: true })
    const reads = result.sites.filter((site) => site.kind === 'model_read')
    assert.equal(reads.length, 4)
    assert.equal(reads[0].projection.mode, 'FULL_ROW')
    assert.deepEqual(reads[1].projection.selected_fields, ['apiHash', 'id'])
    assert.deepEqual(reads[2].projection.omitted_fields, ['sessionData'])
    assert.equal(reads[3].projection.mode, 'AGGREGATE')
    const rawReads = result.sites.filter((site) => site.kind === 'raw')
    assert.deepEqual(rawReads.map((site) => site.read_tables), [['ApiConnection'], ['Bot']])
    assert.deepEqual(rawReads[0].selected_columns, ['apiKey'])
    assert.equal(rawReads[1].select_all, true)
})

test('optional read inventory includes Drizzle full-row and explicit projections', () => {
    const result = analyzePrismaWriteSites([
        "import { appSettings, authUsers, type Database } from '@avito/db'",
        'async function reads(db: Database) {',
        '  await db.select().from(appSettings)',
        '  await db.select({ password: authUsers.passwordHash }).from(authUsers)',
        '  await db.query.authUsers.findMany({ columns: { id: true } })',
        '}',
    ].join('\n'), { includeReads: true })
    const reads = result.sites.filter((site) => site.kind === 'model_read')
    assert.deepEqual(reads.map((site) => [site.model, site.method, site.projection.mode]), [
        ['appSettings', 'drizzle:select', 'FULL_ROW'],
        ['authUsers', 'drizzle:select', 'SELECT'],
        ['authUsers', 'drizzle:findMany', 'SELECT'],
    ])
    assert.deepEqual(reads[1].projection.selected_fields, ['passwordHash'])
})

test('computed Drizzle projections are fail-closed because aliases can hide secret fields', () => {
    const result = analyzePrismaWriteSites([
        "import { authUsers, type Database } from '@avito/db'",
        'async function reads(db: Database) {',
        '  await db.select({ password: sql`${authUsers.passwordHash}` }).from(authUsers)',
        '}',
    ].join('\n'), { includeReads: true })
    assert.equal(result.sites.length, 1)
    assert.equal(result.sites[0].projection.dynamic, true)
})

test('optional raw read inventory includes generic SQL drivers without inventing a mutation', () => {
    const result = analyzePrismaWriteSites([
        'db.query(`SELECT token FROM bots`)',
        'database.execute("SELECT apiKey FROM ApiConnection")',
    ].join('\n'), { includeRawReads: true })
    assert.equal(result.sites.length, 2)
    assert(result.sites.every((site) => site.kind === 'raw' && site.operations.length === 0))
    assert.deepEqual(result.sites.map((site) => site.read_tables), [['bots'], ['ApiConnection']])
    assert.deepEqual(result.sites.map((site) => site.selected_columns), [['token'], ['apiKey']])
    assert(result.sites.every((site) => !site.ambiguity_reasons.includes('execute_raw_mutation_not_recognized')))
})

test('model and raw sites receive deterministic scope-bound signatures', () => {
    const source = [
        'async function persist() {',
        '  await prisma.chat.create({})',
        '  await prisma.$executeRaw`DELETE FROM alpha_table`',
        '}',
    ].join('\n')
    const first = analyzePrismaWriteSites(source, { fileName: 'scope.ts' })
    const second = analyzePrismaWriteSites(source, { fileName: 'scope.ts' })
    assert.deepEqual(first.sites.map((site) => site.site_signature), second.sites.map((site) => site.site_signature))
    assert(first.sites.every((site) => site.scope === 'Function:persist'))
})

test('byte-identical duplicate sites cannot inherit a retired sibling signature', () => {
    const duplicate = 'await prisma.chat.create({})'
    const before = extractPrismaWrites(`async function persist() { ${duplicate}; ${duplicate} }`)
    const after = extractPrismaWrites(`async function persist() { ${duplicate} }`)
    assert.equal(before.length, 2)
    assert.equal(after.length, 1)
    assert.equal(before[0].site_signature, before[1].site_signature)
    assert.notEqual(before[0].site_signature, after[0].site_signature)
})

test('syntax diagnostics are deterministic and do not suppress earlier sites', () => {
    const result = analyzePrismaWriteSites('prisma.chat.create({}); const broken =', { fileName: 'broken.ts' })
    assert.equal(result.sites.length, 1)
    assert(result.diagnostics.length > 0)
    assert.equal(result.diagnostics[0].line, 1)
})

test('the analyzer scans its own tracked implementation without recursion failure', () => {
    const analyzerPath = fileURLToPath(new URL('./write-analyzer.mjs', import.meta.url))
    const result = analyzePrismaWriteSites(readFileSync(analyzerPath, 'utf8'), {
        fileName: 'tools/architecture/v2/write-analyzer.mjs',
    })
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.sites, [])
})

let failures = 0
for (const item of tests) {
    try {
        await item.body()
        process.stdout.write(`ok - ${item.name}\n`)
    } catch (error) {
        failures += 1
        process.stderr.write(`not ok - ${item.name}\n${error.stack ?? error.message}\n`)
    }
}

process.stdout.write(`${tests.length - failures}/${tests.length} v2 write-analyzer tests passed\n`)
if (failures > 0) process.exitCode = 1
