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
const output = mkdtempSync(path.join(tmpdir(), 'yoko-contacts-resolution-tests-'))
const sources = [
    'gravity-mvp/src/contracts/contacts/v1/resolve-contact-command.ts',
    'gravity-mvp/src/contracts/contacts/v1/index.ts',
    'gravity-mvp/src/modules/contacts/public/v1/resolve-contact-handler.ts',
    'gravity-mvp/src/modules/contacts/public/v1/legacy-contact-name-policy.ts',
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
const contracts = require(path.join(output, 'contracts/contacts/v1/index.js'))
const { createResolveContactHandlerV1 } = require(path.join(output, 'modules/contacts/public/v1/resolve-contact-handler.js'))
const { isLegacyPlaceholderContactNameV1 } = require(path.join(output, 'modules/contacts/public/v1/legacy-contact-name-policy.js'))
const checks = []
const check = (name, body) => { body(); checks.push(name) }
const checkAsync = async (name, body) => { await body(); checks.push(name) }

try {
    const command = {
        contract: contracts.RESOLVE_CONTACT_COMMAND_V1,
        operation: contracts.PROMOTE_PLACEHOLDER_DISPLAY_NAME_V1,
        contactId: 'contact-1',
        candidateDisplayName: 'Андрей',
    }

    check('semantic identifiers are explicit v1', () => {
        assert.equal(contracts.RESOLVE_CONTACT_COMMAND_V1, 'contacts.ResolveContactCommand.v1')
        assert.equal(contracts.RESOLVE_CONTACT_RESULT_V1, 'contacts.ResolveContactResult.v1')
    })
    check('valid promotion command parses without drift', () => {
        assert.deepEqual(contracts.parseResolveContactCommandV1(command), command)
    })
    check('v2 cannot silently replace v1', () => {
        assert.throws(
            () => contracts.parseResolveContactCommandV1({ ...command, contract: 'contacts.ResolveContactCommand.v2' }),
            (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
        )
    })
    check('unknown operation and fields fail closed', () => {
        assert.throws(() => contracts.parseResolveContactCommandV1({ ...command, operation: 'overwrite' }))
        assert.throws(() => contracts.parseResolveContactCommandV1({ ...command, provider: 'max' }))
    })
    check('empty identifiers and names fail closed', () => {
        assert.throws(() => contracts.parseResolveContactCommandV1({ ...command, contactId: ' ' }))
        assert.throws(() => contracts.parseResolveContactCommandV1({ ...command, candidateDisplayName: '' }))
    })
    check('legacy empty placeholders remain placeholders', () => {
        for (const value of [undefined, null, '', '   ']) assert.equal(isLegacyPlaceholderContactNameV1(value), true)
    })
    check('legacy channel identifiers remain placeholders', () => {
        for (const value of ['TG 123', 'MAX:123', 'WA 123', 'Telegram 123', 'WhatsApp: 123']) {
            assert.equal(isLegacyPlaceholderContactNameV1(value), true)
        }
    })
    check('legacy numeric and punctuation names remain placeholders', () => {
        for (const value of ['123456', ' .- ', '...']) assert.equal(isLegacyPlaceholderContactNameV1(value), true)
    })
    check('useful names and formatted phones remain preserved', () => {
        for (const value of ['Андрей', 'Alice', '+7 999 123-45-67']) assert.equal(isLegacyPlaceholderContactNameV1(value), false)
    })

    const calls = []
    const handler = createResolveContactHandlerV1({
        async promotePlaceholderDisplayName(input) { calls.push(input); return 'updated' },
    })
    await checkAsync('handler forwards only provider-neutral owner input', async () => {
        const result = await handler(command)
        assert.deepEqual(calls, [{ contactId: 'contact-1', candidateDisplayName: 'Андрей' }])
        assert.deepEqual(result, { contract: contracts.RESOLVE_CONTACT_RESULT_V1, status: 'updated' })
    })
    await checkAsync('not-found and preserved outcomes remain explicit', async () => {
        for (const status of ['not_found', 'preserved']) {
            const result = await createResolveContactHandlerV1({ async promotePlaceholderDisplayName() { return status } })(command)
            assert.equal(result.status, status)
        }
    })
    await checkAsync('invalid command never reaches the owner port', async () => {
        const before = calls.length
        await assert.rejects(handler({ ...command, contactId: '' }))
        assert.equal(calls.length, before)
    })
    await checkAsync('owner persistence failures remain visible', async () => {
        const failing = createResolveContactHandlerV1({ async promotePlaceholderDisplayName() { throw new Error('owner unavailable') } })
        await assert.rejects(failing(command), /owner unavailable/)
    })
} finally {
    rmSync(output, { recursive: true, force: true })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
