#!/usr/bin/env node

// SendToContact, Messaging's send-to-a-person capability, before its Contacts
// permission dependency lands. What exists is pure Messaging code — the
// contract and parser, the request identity (fingerprint and Message id) and
// route discovery — plus the shared physical-retry backoff rule. Nothing can
// reach the SendToContact code yet, so no provider effect can come from an
// incomplete capability:
//   - while the messaging manifest does not declare SendToContact, no file
//     outside the closed set imports it, no barrel exports it, and its intent
//     table does not exist;
//   - the closed set imports no persistence, provider, service or foreign
//     context, and route discovery hands on no proof, target or transport;
//   - the "stc:" Message id namespace is minted in exactly one place;
//   - retrySend and the retry job's selector share one backoff rule.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

import { extractImports } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const sourceRoot = 'gravity-mvp/src'
const contractPath = 'gravity-mvp/src/contracts/messaging/v1/send-to-contact-command.ts'
const requestPath = 'gravity-mvp/src/modules/messaging/application/send-to-contact-request.ts'
const routingPath = 'gravity-mvp/src/modules/messaging/application/send-to-contact-routing.ts'
const conversationsContractPath = 'gravity-mvp/src/contracts/messaging/v1/contact-conversations-query.ts'
const contractsIndexPath = 'gravity-mvp/src/contracts/messaging/v1/index.ts'
const manifestPath = 'architecture/contexts/v1/manifests/messaging.json'
const schemaPath = 'gravity-mvp/prisma/schema.prisma'
const messageServicePath = 'gravity-mvp/src/lib/MessageService.ts'
const selectorPath = 'gravity-mvp/src/modules/messaging/public/v1/delivery-recovery-operations.ts'
const retryPolicyPath = 'gravity-mvp/src/modules/messaging/public/v1/delivery-state-policy.ts'

const closedSet = [contractPath, requestPath, routingPath]
const closedSetTests = [
    'gravity-mvp/src/contracts/messaging/v1/send-to-contact-command.test.ts',
    'gravity-mvp/src/modules/messaging/application/send-to-contact-request.test.ts',
    'gravity-mvp/src/modules/messaging/application/send-to-contact-routing.test.ts',
]
// Each closed-set module may import exactly these, and nothing else.
const allowedImports = new Map([
    [contractPath, []],
    [requestPath, ['../../../contracts/messaging/v1/send-to-contact-command', 'node:crypto']],
    [routingPath, ['../../../contracts/messaging/v1/contact-conversations-query', '../../../contracts/messaging/v1/send-to-contact-command']],
])
const commandFields = ['allowedChannels', 'contactId', 'content', 'contract', 'requestId']
// SC-9: no chat, identity, phone, account, transport, target or provider id crosses the contract.
const forbiddenContractMembers = new Set([
    'chatId', 'conversationId', 'externalChatId', 'externalId', 'identityId', 'contactIdentityId',
    'identityTarget', 'phone', 'phoneId', 'providerAccountId', 'providerMessageId', 'connectionId',
    'target', 'transport', 'route', 'actor', 'canonicalContactId', 'semanticPayloadSha256',
])

function modulePath(relative) {
    return relative.replace(/\.(?:[cm]?[jt]sx?)$/u, '').replace(/\/index$/u, '')
}

function resolveSpecifier(fromFile, specifier) {
    if (specifier.startsWith('@/')) return modulePath(`${sourceRoot}/${specifier.slice(2)}`)
    if (specifier.startsWith('.')) return modulePath(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)))
    return null
}

function sourceFiles(relativeDirectory) {
    return readdirSync(path.join(root, relativeDirectory), { withFileTypes: true }).flatMap((entry) => {
        const relative = `${relativeDirectory}/${entry.name}`
        if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '.next' ? [] : sourceFiles(relative)
        return /\.(?:[cm]?[jt]sx?)$/u.test(entry.name) && !entry.name.endsWith('.d.ts') ? [relative] : []
    })
}

const isTestFile = (file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) || file.includes('/__tests__/')

function isPromoted(manifestSource) {
    return manifestSource.includes('SendToContact')
}

// ── Static validators (each takes source text, so negative probes can feed altered text) ──

function assertContractSurface(source) {
    const sourceFile = ts.createSourceFile(contractPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    assert.equal(sourceFile.parseDiagnostics.length, 0, `${contractPath}: parse diagnostics`)
    assert.deepEqual(extractImports(source), [], `${contractPath}: a contract imports no module code`)
    const interfaces = sourceFile.statements.filter(ts.isInterfaceDeclaration)
    const command = interfaces.find((statement) => statement.name.text === 'SendToContactCommandV1')
    assert(command, `${contractPath}: SendToContactCommandV1 is missing`)
    const fields = command.members.map((member) => member.name?.getText(sourceFile)).sort()
    assert.deepEqual(fields, commandFields, `${contractPath}: the command field set is closed`)
    const allowed = command.members.find((member) => member.name?.getText(sourceFile) === 'allowedChannels')
    assert(allowed.questionToken, `${contractPath}: allowedChannels stays optional (absent = no narrowing)`)
    for (const statement of interfaces) {
        for (const member of statement.members) {
            const name = member.name?.getText(sourceFile)
            assert(!forbiddenContractMembers.has(name), `${contractPath}: ${statement.name.text}.${name} would carry a route or identity across the contract`)
        }
    }
}

function assertClosedImports(file, source) {
    const specifiers = extractImports(source).map((entry) => entry.specifier)
    assert.deepEqual([...new Set(specifiers)].sort(), [...allowedImports.get(file)].sort(), `${file}: closed import set`)
    assert.doesNotMatch(source, /\bprisma\b|\$queryRaw|\$executeRaw|MessageService|fetch\s*\(|globalThis|process\.env|require\s*\(|\bimport\s*\(/u, `${file}: reaches past pure code`)
}

/** `files` maps path → source for every candidate importer. */
function assertNoOutsideImporter(files) {
    const protectedModules = new Set(closedSet.map(modulePath))
    const allowedImporters = new Set([...closedSet, ...closedSetTests])
    for (const [file, source] of files) {
        if (allowedImporters.has(file)) continue
        for (const entry of extractImports(source)) {
            const target = resolveSpecifier(file, entry.specifier)
            assert(!protectedModules.has(target), `${file}: imports ${entry.specifier} before SendToContact is declared`)
        }
    }
}

function assertNotExported(indexSource) {
    for (const entry of extractImports(indexSource)) {
        assert.notEqual(modulePath(path.posix.join('gravity-mvp/src/contracts/messaging/v1', entry.specifier)), modulePath(contractPath), `${contractsIndexPath}: exports the SendToContact contract before it is declared`)
    }
}

function assertNoIntentTable(schemaSource) {
    assert.doesNotMatch(schemaSource, /^\s*model\s+MessagingSendIntent\b/mu, `${schemaPath}: the intent table follows the Contacts permission landing`)
}

/** `files` maps path → source for every runtime (non-test) file. */
function assertStcMintedOnce(files) {
    const minters = [...files].filter(([, source]) => /(['"`])stc:/u.test(source)).map(([file]) => file)
    assert.deepEqual(minters, [requestPath], 'the "stc:" Message id namespace is minted only by the SendToContact request module')
}

function assertSharedBackoff(messageServiceSource, selectorSource) {
    const retrySendStart = messageServiceSource.indexOf('static async retrySend(')
    assert(retrySendStart >= 0, `${messageServicePath}: retrySend is missing`)
    const retrySend = messageServiceSource.slice(retrySendStart, messageServiceSource.indexOf('\n    static ', retrySendStart + 1))
    assert.match(retrySend, /const backoffMs = physicalRetryBackoffMsV1\(attempt\)\n/u, `${messageServicePath}: retrySend takes its backoff from the shared rule`)
    assert.match(retrySend, /const lastFailed = physicalRetryAnchorMsV1\(meta\.lastFailedAt\)\n/u, `${messageServicePath}: retrySend takes its anchor from the shared rule`)
    assert.doesNotMatch(retrySend, /Math\.pow\(|new Date\(meta\.lastFailedAt\)/u, `${messageServicePath}: retrySend keeps a private copy of the backoff rule`)
    assert.match(messageServiceSource, /import \{[^}\n]*\bphysicalRetryAnchorMsV1, physicalRetryBackoffMsV1\b[^}\n]*\} from '@\/modules\/messaging\/public\/v1\/delivery-state-policy'\n/u)
    const clause = [
        "AND CASE WHEN metadata->>'lastFailedAt' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$'",
        "AND pg_input_is_valid(metadata->>'lastFailedAt', 'timestamptz')",
        "THEN (metadata->>'lastFailedAt')::timestamptz",
        "+ LEAST(POWER(2, COALESCE((metadata->>'retryAttempt')::int, 0) + 1) * 30, 600) * INTERVAL '1 second'",
        '<= ${new Date().toISOString()}::timestamptz',
        'ELSE TRUE END',
        'ORDER BY "sentAt" ASC',
    ]
    let cursor = selectorSource.indexOf("AND \"sentAt\" > NOW() - INTERVAL '24 hours'")
    assert(cursor >= 0, `${selectorPath}: the 24-hour window is missing`)
    for (const piece of clause) {
        const next = selectorSource.indexOf(piece, cursor)
        assert(next > cursor, `${selectorPath}: the backoff mirror lost or reordered: ${piece}`)
        cursor = next
    }
}

// ── Real sources ─────────────────────────────────────────────────────────

const manifestSource = read(manifestPath)
const promoted = isPromoted(manifestSource)
const contractSource = read(contractPath)
const runtimeFiles = new Map(sourceFiles(sourceRoot).filter((file) => !isTestFile(file)).map((file) => [file, read(file)]))
const importerCandidates = new Map(sourceFiles(sourceRoot)
    .map((file) => [file, read(file)])
    .filter(([, source]) => source.includes('send-to-contact')))

assertContractSurface(contractSource)
for (const file of closedSet) assertClosedImports(file, read(file))
assertStcMintedOnce(runtimeFiles)
assertSharedBackoff(read(messageServicePath), read(selectorPath))
if (!promoted) {
    assertNoOutsideImporter(importerCandidates)
    assertNotExported(read(contractsIndexPath))
    assertNoIntentTable(read(schemaPath))
}

// ── Behaviour of the compiled closed set ───────────────────────────────────

const out = mkdtempSync(path.join(tmpdir(), 'yoko-send-to-contact-'))
try {
    const compiled = spawnSync(process.execPath, [
        path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc'),
        '--target', 'ES2022',
        '--module', 'commonjs',
        '--moduleResolution', 'node',
        '--strict',
        '--skipLibCheck',
        '--types', 'node',
        '--typeRoots', path.join(root, 'gravity-mvp/node_modules/@types'),
        '--rootDir', path.join(root, sourceRoot),
        '--outDir', out,
        ...[...closedSet, conversationsContractPath, retryPolicyPath].map((file) => path.join(root, file)),
    ], { encoding: 'utf8' })
    if (compiled.status !== 0) {
        process.stderr.write(compiled.stdout + compiled.stderr)
        process.exit(1)
    }
    const require = createRequire(import.meta.url)
    const load = (file) => require(path.join(out, path.relative(sourceRoot, file).replace(/\.ts$/u, '.js')))
    const contract = load(contractPath)
    const request = load(requestPath)
    const routing = load(routingPath)
    const policy = load(retryPolicyPath)

    const command = { contract: 'messaging.SendToContactCommand.v1', requestId: 'r-1', contactId: 'contact-1', content: 'Здравствуйте! 👋' }
    const code = (input) => {
        try { contract.parseSendToContactCommandV1(input) } catch (error) { return error.code }
        return 'ACCEPTED'
    }
    assert.equal(code(command), 'ACCEPTED')
    for (const field of ['chatId', 'channel', 'identityId', 'providerAccountId']) assert.equal(code({ ...command, [field]: 'x' }), 'INVALID_CONTRACT')
    assert.equal(code({ ...command, contract: 'messaging.SendToContactCommand.v2' }), 'UNSUPPORTED_CONTRACT_VERSION')
    for (const allowedChannels of [[], ['telegram', 'telegram'], ['phone']]) assert.equal(code({ ...command, allowedChannels }), 'INVALID_CONTRACT')
    for (const content of ['', '   ', 'x'.repeat(4097), 'a\u0000b']) assert.equal(code({ ...command, content }), 'INVALID_CONTRACT')

    const prepared = request.prepareSendToContactRequestV1(command)
    assert.equal(prepared.semanticPayloadSha256, 'b21d05f9fa155c12f518f8577fba109c02e62c7b82da727ca2991c0e2826c4a3', 'pinned fingerprint vector')
    assert.equal(prepared.clientMessageId, 'stc:r-1')
    const sha = (extra) => request.prepareSendToContactRequestV1({ ...command, ...extra }).semanticPayloadSha256
    assert.equal(sha({ requestId: 'other' }), prepared.semanticPayloadSha256, 'the requestId is not payload')
    assert.equal(sha({ allowedChannels: ['whatsapp', 'telegram'] }), sha({ allowedChannels: ['telegram', 'whatsapp'] }), 'channel order is not payload')
    assert.notEqual(sha({ allowedChannels: ['max', 'telegram', 'whatsapp'] }), prepared.semanticPayloadSha256, 'absent is not the full set')
    assert.notEqual(sha({ content: `${command.content} ` }), prepared.semanticPayloadSha256, 'content is exact')

    const entry = (channels, extra = {}) => ({
        contactId: 'contact-1', status: 'found', canonicalContactId: 'canonical-1', latestConversationId: null, truncated: false,
        channels: channels.map(([channel, ids]) => ({ channel, primaryConversationId: ids[0], conversations: ids.map((conversationId) => ({ conversationId, lastActivityAt: null })) })),
        ...extra,
    })
    const discover = (value, proofs = {}, input = {}) => routing.discoverSendToContactRouteV1(
        { contactId: 'contact-1', expectedCanonicalContactId: 'canonical-1', ...input },
        {
            readContactConversations: async () => value,
            proveRoute: async (candidate) => {
                const proof = proofs[candidate.conversationId]
                if (proof instanceof Error) throw proof
                return { chatId: candidate.conversationId, channel: candidate.channel, target: 'provider-target', connectionId: 'transport' }
            },
        },
    )
    const selected = await discover(entry([['telegram', ['t1']], ['phone', ['p1']]]))
    assert.deepEqual(Object.keys(selected).sort(), ['channel', 'conversationId', 'kind'], 'discovery hands on no proof, target or transport')
    assert.deepEqual(selected, { kind: 'selected', conversationId: 't1', channel: 'telegram' })
    assert.equal((await discover(entry([['telegram', ['t1']], ['whatsapp', ['w1']]]))).refusal.reason, 'route_ambiguous')
    assert.equal((await discover(entry([['telegram', ['t1', 't2']]]))).refusal.reason, 'route_ambiguous')
    assert.deepEqual((await discover(entry([['telegram', ['t1']], ['whatsapp', ['w1']]]), { w1: new Error('ETIMEDOUT') })).refusal, {
        reason: 'route_evidence_incomplete', retryable: true, detail: 'route_proof_unavailable',
    })
    assert.equal((await discover(entry([['telegram', ['t1']]], { truncated: true }))).refusal.detail, 'truncated')
    assert.equal((await discover(entry([['telegram', ['t1']]], { canonicalContactId: 'canonical-2' }))).refusal.detail, 'lineage_moved')
    assert.equal((await discover(entry([['telegram', ['t1']]]), { t1: new Error('CONTACT_CONVERSATION_NOT_PRIVATE') })).refusal.detail, 'conversation_not_private')
    assert.equal((await discover(entry([['max', ['m1']]]), {}, { allowedChannels: ['telegram'] })).refusal.detail, 'not_in_allowed_channels')

    assert.deepEqual([1, 2, 3, 4, 5].map(policy.physicalRetryBackoffMsV1), [60000, 120000, 240000, 480000, 600000])
    const t0 = Date.parse('2026-10-26T12:00:00.000Z')
    const due = (retryAttempt, lastFailedAt, now) => policy.isPhysicalRetryDueV1({ retryAttempt, lastFailedAt }, now)
    assert.equal(due(1, new Date(t0).toISOString(), t0 + 119999), false)
    assert.equal(due(1, new Date(t0).toISOString(), t0 + 120000), true)
    assert.equal(due(1, undefined, t0), true)
    assert.equal(due(1, 'garbage', t0), true)
} finally {
    rmSync(out, { recursive: true, force: true })
}

// ── Negative probes: each validator rejects the change it exists to stop ──

function rejectProbe(source, changed, validate) {
    assert.notEqual(changed, source, 'negative probe must alter its source')
    assert.throws(() => validate(changed))
}

rejectProbe(contractSource, contractSource.replace('  requestId: string\n', '  requestId: string\n  chatId: string\n'), assertContractSurface)
rejectProbe(contractSource, contractSource.replace('  replayed: boolean\n', '  replayed: boolean\n  providerMessageId: string\n'), assertContractSurface)
rejectProbe(contractSource, contractSource.replace('  allowedChannels?: SendToContactChannelV1[]', '  allowedChannels: SendToContactChannelV1[]'), assertContractSurface)
rejectProbe(contractSource, `import { prisma } from '@/lib/prisma'\n${contractSource}`, assertContractSurface)
const routingSource = read(routingPath)
rejectProbe(routingSource, `import { prepareOutboundConversationV1 } from '../public/v1/outbound-conversation-identity-runtime'\n${routingSource}`, (changed) => assertClosedImports(routingPath, changed))
rejectProbe(routingSource, routingSource.replace('export async function discoverSendToContactRouteV1(', 'const leak = () => prisma\nexport async function discoverSendToContactRouteV1('), (changed) => assertClosedImports(routingPath, changed))
const requestSource = read(requestPath)
rejectProbe(requestSource, `import { MessageService } from '@/lib/MessageService'\n${requestSource}`, (changed) => assertClosedImports(requestPath, changed))
const consumer = 'gravity-mvp/src/app/api/messages/send-to-contact/route.ts'
for (const specifier of ['@/modules/messaging/application/send-to-contact-routing', '../../../../modules/messaging/application/send-to-contact-request', '@/contracts/messaging/v1/send-to-contact-command']) {
    rejectProbe('', `import { x } from '${specifier}'\n`, (changed) => assertNoOutsideImporter(new Map([[consumer, changed]])))
}
rejectProbe('', "const load = () => import('@/modules/messaging/application/send-to-contact-request')\n", (changed) => assertNoOutsideImporter(new Map([[consumer, changed]])))
const indexSource = read(contractsIndexPath)
rejectProbe(indexSource, `${indexSource}export * from './send-to-contact-command'\n`, assertNotExported)
rejectProbe('', 'model MessagingSendIntent {\n  requestId String @id\n}\n', assertNoIntentTable)
rejectProbe('', "const clientMessageId = 'stc:' + requestId\n", (changed) => assertStcMintedOnce(new Map([...runtimeFiles, ['gravity-mvp/src/lib/MessageService.ts', changed]])))
rejectProbe('', 'const clientMessageId = `stc:${requestId}`\n', (changed) => assertStcMintedOnce(new Map([...runtimeFiles, ['gravity-mvp/src/app/api/messages/route.ts', changed]])))
const messageServiceSource = read(messageServicePath)
const selectorSource = read(selectorPath)
rejectProbe(
    messageServiceSource,
    messageServiceSource.replace('const backoffMs = physicalRetryBackoffMsV1(attempt)', 'const backoffMs = Math.min(Math.pow(2, attempt) * 30000, 10 * 60 * 1000)'),
    (changed) => assertSharedBackoff(changed, selectorSource),
)
rejectProbe(
    messageServiceSource,
    messageServiceSource.replace('const lastFailed = physicalRetryAnchorMsV1(meta.lastFailedAt)', 'const lastFailed = meta.lastFailedAt ? new Date(meta.lastFailedAt).getTime() : 0'),
    (changed) => assertSharedBackoff(changed, selectorSource),
)
rejectProbe(selectorSource, selectorSource.replace('                   ELSE TRUE END\n', '                   ELSE FALSE END\n'), (changed) => assertSharedBackoff(messageServiceSource, changed))
rejectProbe(selectorSource, selectorSource.replace(" + 1) * 30, 600) * INTERVAL '1 second'", ") * 30, 600) * INTERVAL '1 second'"), (changed) => assertSharedBackoff(messageServiceSource, changed))
rejectProbe(selectorSource, selectorSource.replace('<= ${new Date().toISOString()}::timestamptz', '<= NOW()'), (changed) => assertSharedBackoff(messageServiceSource, changed))
assert.equal(isPromoted('{"commands":["SendToContactCommand.v1"]}'), true)
assert.equal(isPromoted(manifestSource.replace(/SendToContact/gu, 'Other')), false)

process.stdout.write(`messaging send-to-contact boundary: PASS (${promoted ? 'declared' : 'pre-public: unreachable, unexported, no intent table'})\n`)
