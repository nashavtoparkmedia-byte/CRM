#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-contact-manual-name-'))
const sources = [
    'gravity-mvp/src/contracts/contacts/v1/set-contact-display-name-command.ts',
    'gravity-mvp/src/contracts/contacts/v1/index.ts',
    'gravity-mvp/src/modules/contacts/public/v1/set-contact-display-name-handler.ts',
].map((value) => path.join(root, value))
const compile = spawnSync(process.execPath, [
    path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc'), '--target', 'ES2022',
    '--module', 'commonjs', '--moduleResolution', 'node', '--strict', '--skipLibCheck',
    '--rootDir', path.join(root, 'gravity-mvp/src'), '--outDir', out, ...sources,
], { encoding: 'utf8' })
if (compile.status !== 0) {
    process.stderr.write(compile.stdout + compile.stderr)
    process.exit(1)
}

const require = createRequire(import.meta.url)
const contracts = require(path.join(out, 'contracts/contacts/v1/index.js'))
const { createSetContactDisplayNameHandlerV1 } = require(path.join(out, 'modules/contacts/public/v1/set-contact-display-name-handler.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }

try {
    const command = {
        contract: contracts.SET_CONTACT_DISPLAY_NAME_COMMAND_V1,
        contactId: 'contact-1',
        displayName: 'Иван Иванов',
    }
    check('v1 identifier explicit', () => assert.equal(
        contracts.SET_CONTACT_DISPLAY_NAME_COMMAND_V1, 'contacts.SetContactDisplayNameCommand.v1',
    ))
    check('valid command parses unchanged', () => assert.deepEqual(
        contracts.parseSetContactDisplayNameCommandV1(command), command,
    ))
    check('v2 cannot enter v1 parser', () => assert.throws(
        () => contracts.parseSetContactDisplayNameCommandV1({ ...command, contract: 'contacts.SetContactDisplayNameCommand.v2' }),
        (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
    ))
    check('unknown fields fail', () => assert.throws(
        () => contracts.parseSetContactDisplayNameCommandV1({ ...command, source: 'driver' }),
    ))
    check('contact id is required', () => assert.throws(
        () => contracts.parseSetContactDisplayNameCommandV1({ ...command, contactId: '' }),
    ))
    check('display name is required', () => assert.throws(
        () => contracts.parseSetContactDisplayNameCommandV1({ ...command, displayName: '' }),
    ))

    const calls = []
    const handler = createSetContactDisplayNameHandlerV1({
        async setDisplayName(input) { calls.push(input); return 'updated' },
    })
    await checkAsync('owner receives exact id and name', async () => {
        const result = await handler(command)
        assert.deepEqual(calls, [{ contactId: 'contact-1', displayName: 'Иван Иванов' }])
        assert.deepEqual(result, { contract: contracts.SET_CONTACT_DISPLAY_NAME_RESULT_V1, status: 'updated' })
    })
    await checkAsync('missing contact is an explicit no-op', async () => {
        const result = await createSetContactDisplayNameHandlerV1({ async setDisplayName() { return 'not_found' } })(command)
        assert.equal(result.status, 'not_found')
    })
    await checkAsync('invalid command never reaches persistence', async () => {
        const before = calls.length
        await assert.rejects(handler({ ...command, displayName: null }))
        assert.equal(calls.length, before)
    })
    await checkAsync('persistence failures remain visible', async () => {
        const failing = createSetContactDisplayNameHandlerV1({ async setDisplayName() { throw new Error('owner unavailable') } })
        await assert.rejects(failing(command), /owner unavailable/)
    })
} finally {
    rmSync(out, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
