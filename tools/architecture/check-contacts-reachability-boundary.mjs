#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const implementationPath = 'gravity-mvp/src/lib/ReachabilityService.ts'
const publicPath = 'gravity-mvp/src/modules/contacts/public/v1/contact-reachability.ts'
const routePath = 'gravity-mvp/src/app/api/channels/check-reachability/route.ts'
const profileDrawerPath = 'gravity-mvp/src/app/messages/components/ContactProfileDrawer.tsx'
const messageServicePath = 'gravity-mvp/src/lib/MessageService.ts'
const consumers = [routePath, messageServicePath]
const exactCapabilities = [
    'recordExactProviderReachability',
]

assert.equal(sha256(read(implementationPath)), 'a3935cadbcdcd743814b8dd08c01cefcf2947a1ca830beba3f35b1c32dd79970')

function capabilityKeys(source) {
    const body = source.match(/Object\.freeze\(\{([\s\S]*?)\}\)/)?.[1] ?? ''
    return [...body.matchAll(/^ {4}(\w+):/gm)].map((match) => match[1]).sort()
}

const publicSource = read(publicPath)
assert.deepEqual(capabilityKeys(publicSource), exactCapabilities)
assert.match(publicSource, /recordExactProviderReachability\(command\)/)
assert.doesNotMatch(publicSource, /updateReachabilityByChatId/)
assert.doesNotMatch(publicSource, /delete|merge|create|deactivate|\bprisma\b|export \*/)
const unrelatedWriteProbe = publicSource.replace(
    /\n\}\)\n$/,
    "\n    deactivateIdentity: (identityId) => deactivateIdentity(identityId),\n})\n",
)
assert.notDeepEqual(capabilityKeys(unrelatedWriteProbe), exactCapabilities)

const routeSource = read(routePath)
assert.match(routeSource, /@\/modules\/contacts\/public\/v1\/contact-reachability/)
assert.match(routeSource, /contactReachabilityV1\.recordExactProviderReachability\(\{/)
assert.match(routeSource, /identityId: exactBinding\.identityId/)
assert.match(routeSource, /contactId: exactBinding\.contactId/)
assert.match(routeSource, /providerAccountId: result\.providerAccountId/)
assert.match(routeSource, /providerTargetId: result\.providerTargetId/)
assert.doesNotMatch(routeSource, /findIdentityByPhoneAndChannel|findFirst\([^)]*phone/)
assert.doesNotMatch(routeSource, /\bprisma\b|@\/lib\/prisma/)

const implementationSource = read(implementationPath)
assert.doesNotMatch(implementationSource, /findIdentityByPhoneAndChannel|contactIdentity\.findFirst/)
assert.match(implementationSource, /where: \{ id: identityId \}/)
assert.match(implementationSource, /identity\.contactId !== contactId/)
assert.match(implementationSource, /identityEvidence\.providerAliasValues/)
assert.match(implementationSource, /exactProviderTargets\.has\(providerTargetId\)/)
assert.doesNotMatch(implementationSource, /updateReachabilityByChatId/)

// Provider-account authority is deferred (docs/design/provider-account-identity-v1.md).
// The stamp is accepted as metadata and must never admit or reject a proof, so the
// ~1k live identities that carry no stamp stay recordable. Pin both halves: the
// stamp raises no rejection, and every rejection that does carry the boundary
// remains present and reachable.
assert.match(implementationSource, /providerAccountId\?: string \| null/)
assert.doesNotMatch(implementationSource, /reason: 'provider_account_(unproven|mismatch)'/)
assert.doesNotMatch(implementationSource, /'provider_account_(unproven|mismatch)'/)
for (const preservedRejection of [
    'identity_not_found',
    'identity_inactive',
    'contact_owner_mismatch',
    'contact_archived',
    'channel_mismatch',
    'identity_conflicted',
    'provider_target_mismatch',
]) {
    assert.match(implementationSource, new RegExp(`reason: '${preservedRejection}'`))
}

// A transport collision is not a person conflict (M1). The open-conflict deny is
// delegated to the Contacts classifier, which exempts only a collision its own
// details prove transport-only, and the identity-level conflict flag still denies
// unconditionally. A local predicate that ignores or re-derives the distinction
// would reopen either the person lockout or the fail-open.
assert.match(implementationSource, /identityEvidenceState\(identity\.metadata\)\.conflictState === 'conflicted'\n\s+\|\| hasPersonBlockingIdentityConflictV1\(identity\.contact\.customFields, identity\)/)
assert.doesNotMatch(implementationSource, /identityConflicts|isProvenTransportOnly|conflict\.status === 'open'/)
const evidenceStateSource = read('gravity-mvp/src/modules/contacts/public/v1/contact-evidence-state.ts')
assert.match(evidenceStateSource, /export function hasPersonBlockingIdentityConflictV1\(/)
assert.match(evidenceStateSource, /record\.conflictType !== 'channel_identity_collision' \|\| record\.source !== 'channel-ingress'/)

// The classifier is executed, not pattern-matched, so a body that stops blocking
// genuine conflicts, or starts blocking proven transport-only ones, cannot pass.
const { default: ts } = await import('../../gravity-mvp/node_modules/typescript/lib/typescript.js')
const evidenceState = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(evidenceStateSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64')}`)
const probeIdentity = { id: 'identity-probe', channel: 'telegram', externalId: '42' }
const probeCollision = (reason, details, overrides = {}) => ({
    identityId: probeIdentity.id,
    conflictType: 'channel_identity_collision',
    source: 'channel-ingress',
    status: 'open',
    details: { ...details, channel: probeIdentity.channel, reason, externalUserId: probeIdentity.externalId },
    ...overrides,
})
const botTransportOnly = probeCollision('transport_connection_mismatch', {
    incomingConnectionId: 'driver-bot-primary',
    existingConnectionId: '7001',
    incomingChatKind: 'private',
    existingChatKind: 'private',
})
const blocks = (...conflicts) => evidenceState.hasPersonBlockingIdentityConflictV1({ identityConflicts: conflicts }, probeIdentity)
assert.equal(blocks(botTransportOnly), false, 'a proven transport-only collision must not disable the person')
assert.equal(blocks(probeCollision('peer_identity_mismatch', { incomingPeerId: '42', existingPeerId: '99' })), true, 'a genuine person conflict must block')
assert.equal(blocks(botTransportOnly, probeCollision('chat_kind_mismatch', { incomingChatKind: 'private', existingChatKind: 'group' })), true, 'a genuine conflict beside a transport-only one must block')
assert.equal(blocks(probeCollision('transport_connection_mismatch', { ...botTransportOnly.details, existingChatKind: 'group' })), true, 'a transport reason masking a chat-kind contradiction must block')
assert.equal(blocks(probeCollision('transport_connection_mismatch', {
    incomingPeerId: '42', existingPeerId: '42', incomingConnectionId: '7002', existingConnectionId: '7001',
})), true, 'an unprovable historical MTProto transport entry must block')
assert.equal(blocks(probeCollision('transport_connection_mismatch', {
    ...botTransportOnly.details, incomingPeerId: '42', existingPeerId: '42',
})), true, 'an MTProto-shaped entry stays unprovable even when chat kinds are present')
assert.equal(blocks({ ...botTransportOnly, conflictType: 'manual_identity_conflict' }), true, 'another conflict type must block')
assert.equal(blocks({ ...botTransportOnly, source: 'manual-review' }), true, 'a collision from another origin must block')
assert.equal(blocks({ ...botTransportOnly, details: { ...botTransportOnly.details, externalUserId: '99' } }), true, 'a transport record naming another peer must block')
assert.equal(blocks({ ...botTransportOnly, details: { ...botTransportOnly.details, channel: 'max' } }), true, 'a transport record from another channel must block')
assert.equal(blocks(probeCollision('peer_identity_mismatch', { incomingPeerId: '42', existingPeerId: '99' }, { status: 'resolved' })), false, 'a resolved genuine entry is not open')
assert.equal(blocks({ ...botTransportOnly, identityId: 'another-identity' }), false, 'an entry about another identity does not block this one')
assert.equal(blocks({ ...botTransportOnly, identityId: 'another-identity', details: { ...botTransportOnly.details, reason: 'peer_identity_mismatch' } }), false, 'a genuine conflict about another identity does not block this one')

// Contacts refuses to record any transport-class reason as a person conflict,
// whatever the caller, so a writer regression cannot reopen the person lockout.
const conflictWriterSource = read('gravity-mvp/src/modules/contacts/public/v1/channel-identity-conflict.ts')
assert.match(conflictWriterSource, /function validate\(input: MarkChannelIdentityConflictInputV1\): void \{[\s\S]*?if \(isTransportCollisionReasonV1\(input\.channel, input\.reason\)\) \{\n\s+throw new TypeError\('transport collision is not a person identity conflict'\)/)
assert.match(conflictWriterSource, /export async function markChannelIdentityConflictV1\([\s\S]*?\{\n\s+validate\(input\)/)
for (const [channel, reason] of [
    ['telegram', 'transport_connection_mismatch'], ['telegram', 'transport_connection_unproven'],
    ['telegram', 'provider_account_mismatch'], ['telegram', 'provider_account_unproven'],
    ['whatsapp', 'transport_mismatch'], ['whatsapp', 'transport_unbound'],
    ['max', 'provider_account_mismatch'], ['max', 'provider_account_unproven'],
]) assert.equal(evidenceState.isTransportCollisionReasonV1(channel, reason), true, `${channel} ${reason} is a transport reason`)
for (const [channel, reason] of [
    ['telegram', 'peer_identity_mismatch'], ['telegram', 'chat_kind_mismatch'], ['max', 'sender_identity_mismatch'],
    ['max', 'sender_identity_unproven'], ['max', 'chat_kind_mismatch'], ['max', 'message_chat_mismatch'],
]) assert.equal(evidenceState.isTransportCollisionReasonV1(channel, reason), false, `${channel} ${reason} is a person reason`)

const profileDrawerSource = read(profileDrawerPath)
assert.match(profileDrawerSource, /identityId: identity\.id/)
assert.match(profileDrawerSource, /contactId: contact\.id/)
assert.match(profileDrawerSource, /providerAccountId,/)
assert.match(profileDrawerSource, /item => item\.phoneId === phone\.id && item\.channel === channel/)
assert.match(profileDrawerSource, /reachabilityKey\(identity\.phoneId, identity\.channel, identity\.id\)/)
assert.match(profileDrawerSource, /body: JSON\.stringify\(\{ phone, channel, \.\.\.exactIdentityBinding \}\)/)

const messageServiceSource = read(messageServicePath)
assert.match(messageServiceSource, /@\/modules\/contacts\/public\/v1\/contact-reachability/)
assert.match(messageServiceSource, /contactReachabilityV1\.recordExactProviderReachability\(\{/)
assert.match(messageServiceSource, /identityId: outboundBinding\.contactIdentityId/)
assert.match(messageServiceSource, /contactId: outboundBinding\.contactId/)
assert.match(messageServiceSource, /providerAccountId: outboundBinding\.providerAccountId/)
assert.match(messageServiceSource, /providerTargetId: outboundBinding\.identityTarget/)
assert.doesNotMatch(messageServiceSource, /updateReachabilityByChatId/)

for (const consumerPath of consumers) {
    assert.doesNotMatch(read(consumerPath), /@\/lib\/ReachabilityService/)
}

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/contacts.json'))
assert(manifest.public_surface.includes('ContactReachability.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    consumers.includes(finding.file) && finding.details?.target === implementationPath
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: consumers.length,
    reachability_capabilities: exactCapabilities.length,
    negative_unrelated_write_probe: 'REJECTED',
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
