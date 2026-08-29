#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const compiler = path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc')
const output = mkdtempSync(path.join(tmpdir(), 'yoko-contacts-identity-tests-'))
const sources = [
    'gravity-mvp/src/contracts/contacts/v1/resolve-contact-command.ts',
    'gravity-mvp/src/contracts/contacts/v1/attach-contact-identity-command.ts',
    'gravity-mvp/src/contracts/contacts/v1/index.ts',
    'gravity-mvp/src/modules/contacts/public/v1/attach-contact-identity-handler.ts',
].map((value) => path.join(root, value))
const compile = spawnSync(process.execPath, [compiler, '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node', '--strict', '--skipLibCheck', '--rootDir', path.join(root, 'gravity-mvp/src'), '--outDir', output, ...sources], { encoding: 'utf8' })
if (compile.status !== 0) { process.stderr.write(compile.stdout + compile.stderr); rmSync(output, { recursive: true, force: true }); process.exit(1) }
const require = createRequire(import.meta.url)
const contracts = require(path.join(output, 'contracts/contacts/v1/index.js'))
const { createAttachContactIdentityHandlerV1 } = require(path.join(output, 'modules/contacts/public/v1/attach-contact-identity-handler.js'))
const checks = []
const check = (name, fn) => { fn(); checks.push(name) }
const checkAsync = async (name, fn) => { await fn(); checks.push(name) }
try {
    const command = { contract: contracts.ATTACH_CONTACT_IDENTITY_COMMAND_V1, operation: contracts.REPLACE_IDENTITY_PROFILE_V1, identityId: 'identity-1', profile: { handle: 'driver', givenName: 'Anna', familyName: null } }
    check('semantic identifiers are explicit v1', () => assert.equal(contracts.ATTACH_CONTACT_IDENTITY_COMMAND_V1, 'contacts.AttachContactIdentityCommand.v1'))
    check('valid generic profile parses', () => assert.deepEqual(contracts.parseAttachContactIdentityCommandV1(command), command))
    check('v2 fails closed', () => assert.throws(() => contracts.parseAttachContactIdentityCommandV1({ ...command, contract: 'contacts.AttachContactIdentityCommand.v2' }), (e) => e.code === 'UNSUPPORTED_CONTRACT_VERSION'))
    check('provider-specific profile field fails closed', () => assert.throws(() => contracts.parseAttachContactIdentityCommandV1({ ...command, profile: { ...command.profile, username: 'hidden' } })))
    check('unknown command field fails closed', () => assert.throws(() => contracts.parseAttachContactIdentityCommandV1({ ...command, provider: 'telegram' })))
    check('empty identity fails closed', () => assert.throws(() => contracts.parseAttachContactIdentityCommandV1({ ...command, identityId: '' })))
    check('non-string profile values fail closed', () => assert.throws(() => contracts.parseAttachContactIdentityCommandV1({ ...command, profile: { ...command.profile, handle: 42 } })))
    const calls = []
    const handler = createAttachContactIdentityHandlerV1({ async replaceProfile(input) { calls.push(input) } })
    await checkAsync('handler maps generic profile without drift', async () => { const result = await handler(command); assert.deepEqual(calls, [{ identityId: 'identity-1', handle: 'driver', givenName: 'Anna', familyName: null }]); assert.equal(result.identityId, 'identity-1') })
    await checkAsync('null profile values are preserved', async () => { await handler({ ...command, profile: { handle: null, givenName: null, familyName: null } }); assert.deepEqual(calls.at(-1), { identityId: 'identity-1', handle: null, givenName: null, familyName: null }) })
    await checkAsync('invalid command never reaches port', async () => { const before = calls.length; await assert.rejects(handler({ ...command, identityId: '' })); assert.equal(calls.length, before) })
    await checkAsync('owner failure remains visible', async () => { const failing = createAttachContactIdentityHandlerV1({ async replaceProfile() { throw new Error('owner unavailable') } }); await assert.rejects(failing(command), /owner unavailable/) })
} finally { rmSync(output, { recursive: true, force: true }) }
process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
