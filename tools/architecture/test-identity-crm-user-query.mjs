#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const compiler = process.env.YOKO_TSC_PATH
    ?? path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc')
const output = mkdtempSync(path.join(tmpdir(), 'yoko-identity-crm-user-query-tests-'))
const sources = [
    'gravity-mvp/src/contracts/identity-access/v1/crm-user-query.ts',
    'gravity-mvp/src/modules/identity-access/public/v1/crm-user-query-handler.ts',
].map((value) => path.join(root, value))

const compile = spawnSync(process.execPath, [
    compiler,
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--strict',
    '--skipLibCheck',
    '--rootDir', path.join(root, 'gravity-mvp/src'),
    '--outDir', output,
    ...sources,
], { encoding: 'utf8' })

if (compile.status !== 0) {
    process.stderr.write(compile.stdout)
    process.stderr.write(compile.stderr)
    rmSync(output, { recursive: true, force: true })
    process.exit(1)
}

const require = createRequire(import.meta.url)
const contracts = require(path.join(output, 'contracts/identity-access/v1/crm-user-query.js'))
const { createCrmUserQueryHandlerV1 } = require(path.join(
    output,
    'modules/identity-access/public/v1/crm-user-query-handler.js',
))
const checks = []
const check = (name, body) => {
    body()
    checks.push(name)
}
const checkAsync = async (name, body) => {
    await body()
    checks.push(name)
}

try {
    const query = { contract: contracts.CRM_USER_QUERY_V1, userId: 'manager-2' }
    check('CRM user query contract is explicit v1', () => {
        assert.equal(contracts.CRM_USER_QUERY_V1, 'identity_access.CrmUserQuery.v1')
        assert.equal(contracts.CRM_USER_RESULT_V1, 'identity_access.CrmUserResult.v1')
    })
    check('valid lookup query parses without drift', () => {
        assert.deepEqual(contracts.parseCrmUserQueryV1(query), query)
    })
    check('v2 cannot silently replace v1', () => {
        assert.throws(
            () => contracts.parseCrmUserQueryV1({ ...query, contract: 'identity_access.CrmUserQuery.v2' }),
            (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
        )
    })
    check('unrelated directory operation fails closed', () => {
        assert.throws(
            () => contracts.parseCrmUserQueryV1({ ...query, listAll: true }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
    })

    const calls = []
    const handler = createCrmUserQueryHandlerV1({
        async findById(userId) {
            calls.push(userId)
            return { id: userId, name: 'Анна' }
        },
    })
    await checkAsync('handler returns only the explicit CRM user projection', async () => {
        assert.deepEqual(await handler(query), {
            contract: contracts.CRM_USER_RESULT_V1,
            user: { id: 'manager-2', name: 'Анна' },
        })
        assert.deepEqual(calls, ['manager-2'])
    })
    await checkAsync('missing CRM user remains explicit null', async () => {
        const missing = createCrmUserQueryHandlerV1({ async findById() { return null } })
        assert.deepEqual(await missing(query), {
            contract: contracts.CRM_USER_RESULT_V1,
            user: null,
        })
    })
} finally {
    rmSync(output, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
