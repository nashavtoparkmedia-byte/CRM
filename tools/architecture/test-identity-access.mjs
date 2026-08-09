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
const output = mkdtempSync(path.join(tmpdir(), 'yoko-identity-contract-tests-'))
const sources = [
    'gravity-mvp/src/contracts/identity-access/v1/identity-access.ts',
    'gravity-mvp/src/contracts/identity-access/v1/index.ts',
    'gravity-mvp/src/modules/identity-access/public/v1/identity-access-handler.ts',
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
const contracts = require(path.join(output, 'contracts/identity-access/v1/index.js'))
const { createIdentityAccessHandlerV1 } = require(path.join(
    output,
    'modules/identity-access/public/v1/identity-access-handler.js',
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
    check('semantic identifiers are explicit v1', () => {
        assert.equal(contracts.CURRENT_USER_QUERY_V1, 'identity_access.CurrentUserQuery.v1')
        assert.equal(contracts.LIST_USER_IDENTITIES_QUERY_V1, 'identity_access.ListUserIdentitiesQuery.v1')
        assert.equal(contracts.AUTHENTICATE_USER_COMMAND_V1, 'identity_access.AuthenticateUserCommand.v1')
        assert.equal(contracts.END_USER_SESSION_COMMAND_V1, 'identity_access.EndUserSessionCommand.v1')
    })
    check('current-user query parses', () => {
        assert.deepEqual(
            contracts.parseCurrentUserQueryV1({ contract: contracts.CURRENT_USER_QUERY_V1 }),
            { contract: contracts.CURRENT_USER_QUERY_V1 },
        )
    })
    check('current-user v2 cannot replace v1', () => {
        assert.throws(
            () => contracts.parseCurrentUserQueryV1({ contract: 'identity_access.CurrentUserQuery.v2' }),
            (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
        )
    })
    check('query envelope rejects unknown fields', () => {
        assert.throws(
            () => contracts.parseListUserIdentitiesQueryV1({
                contract: contracts.LIST_USER_IDENTITIES_QUERY_V1,
                includeDisabled: true,
            }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
    })
    check('authenticate command requires a non-empty target', () => {
        assert.throws(
            () => contracts.parseAuthenticateUserCommandV1({
                contract: contracts.AUTHENTICATE_USER_COMMAND_V1,
                targetUserId: '',
            }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
    })
    check('authenticate v2 cannot replace v1', () => {
        assert.throws(
            () => contracts.parseAuthenticateUserCommandV1({
                contract: 'identity_access.AuthenticateUserCommand.v2',
                targetUserId: 'u1',
            }),
            (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
        )
    })
    check('end-session envelope rejects unknown fields', () => {
        assert.throws(
            () => contracts.parseEndUserSessionCommandV1({
                contract: contracts.END_USER_SESSION_COMMAND_V1,
                reason: 'hidden-semantic-change',
            }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
    })

    const user = {
        id: 'u1',
        firstName: 'Anna',
        lastName: 'Manager',
        role: 'Менеджер',
        status: 'Активен',
        createdAt: '2026-01-01T00:00:00.000Z',
    }
    const calls = []
    const handler = createIdentityAccessHandlerV1({
        async getCurrentUser() {
            calls.push(['getCurrentUser'])
            return user
        },
        async listUsers() {
            calls.push(['listUsers'])
            return [user]
        },
        async authenticate(targetUserId) {
            calls.push(['authenticate', targetUserId])
        },
        async endSession() {
            calls.push(['endSession'])
        },
    })

    await checkAsync('current-user result is versioned and preserves nullability', async () => {
        const result = await handler.queryCurrentUser({ contract: contracts.CURRENT_USER_QUERY_V1 })
        assert.equal(result.contract, contracts.CURRENT_USER_RESULT_V1)
        assert.deepEqual(result.user, user)
    })
    await checkAsync('list result is versioned and preserves identity fields', async () => {
        const result = await handler.listUserIdentities({ contract: contracts.LIST_USER_IDENTITIES_QUERY_V1 })
        assert.equal(result.contract, contracts.LIST_USER_IDENTITIES_RESULT_V1)
        assert.deepEqual(result.users, [user])
    })
    await checkAsync('authenticate forwards only validated target identity', async () => {
        const result = await handler.authenticateUser({
            contract: contracts.AUTHENTICATE_USER_COMMAND_V1,
            targetUserId: 'u3',
        })
        assert.equal(result.contract, contracts.AUTHENTICATE_USER_RESULT_V1)
        assert.deepEqual(calls.at(-1), ['authenticate', 'u3'])
    })
    await checkAsync('invalid authenticate never reaches the port', async () => {
        const before = calls.length
        await assert.rejects(
            handler.authenticateUser({ contract: contracts.AUTHENTICATE_USER_COMMAND_V1, targetUserId: '' }),
            (error) => error.code === 'INVALID_CONTRACT',
        )
        assert.equal(calls.length, before)
    })
    await checkAsync('end session invokes the owner port exactly once', async () => {
        const result = await handler.endUserSession({ contract: contracts.END_USER_SESSION_COMMAND_V1 })
        assert.equal(result.contract, contracts.END_USER_SESSION_RESULT_V1)
        assert.deepEqual(calls.at(-1), ['endSession'])
    })
    await checkAsync('owner port failures remain visible', async () => {
        const failing = createIdentityAccessHandlerV1({
            async getCurrentUser() { throw new Error('owner unavailable') },
            async listUsers() { return [] },
            async authenticate() {},
            async endSession() {},
        })
        await assert.rejects(
            failing.queryCurrentUser({ contract: contracts.CURRENT_USER_QUERY_V1 }),
            /owner unavailable/,
        )
    })
} finally {
    rmSync(output, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
