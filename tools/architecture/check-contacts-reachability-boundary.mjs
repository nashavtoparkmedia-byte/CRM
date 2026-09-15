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

// The MAX and WhatsApp branches carry their own proof rules: an account reason
// can mask a MAX sender or chat-kind contradiction, and a label is never enough
// unless the recorded values express it.
const channelBlocks = (identity, reason, details) => evidenceState.hasPersonBlockingIdentityConflictV1({
    identityConflicts: [{
        identityId: identity.id,
        conflictType: 'channel_identity_collision',
        source: 'channel-ingress',
        status: 'open',
        details: { ...details, channel: identity.channel, reason, externalUserId: identity.externalId },
    }],
}, identity)
const maxIdentity = { id: 'identity-max', channel: 'max', externalId: 'sender-42' }
const maxTransportOnly = {
    incomingProviderAccountId: 'max-account-b', existingProviderAccountId: 'max-account-a',
    incomingSenderId: 'sender-42', existingSenderId: 'sender-42', incomingChatKind: 'private', existingChatKind: 'private',
}
assert.equal(channelBlocks(maxIdentity, 'provider_account_mismatch', maxTransportOnly), false, 'a proven MAX account-only collision must not disable the person')
assert.equal(channelBlocks(maxIdentity, 'provider_account_mismatch', { ...maxTransportOnly, existingSenderId: 'sender-99' }), true, 'a MAX account reason masking a sender contradiction must block')
assert.equal(channelBlocks(maxIdentity, 'provider_account_mismatch', { ...maxTransportOnly, existingSenderId: null }), true, 'a MAX account reason masking missing sender proof must block')
assert.equal(channelBlocks(maxIdentity, 'provider_account_mismatch', { ...maxTransportOnly, incomingChatKind: 'group' }), true, 'a MAX account reason masking group traffic must block')
assert.equal(channelBlocks(maxIdentity, 'provider_account_mismatch', { ...maxTransportOnly, existingChatKind: 'group' }), true, 'a MAX account reason masking a concrete kind contradiction must block')
assert.equal(channelBlocks(maxIdentity, 'provider_account_mismatch', { ...maxTransportOnly, existingChatKind: 'channel', incomingChatKind: 'unknown' }), true, 'a MAX kind outside the recorded vocabulary must block')
assert.equal(channelBlocks(maxIdentity, 'provider_account_mismatch', { ...maxTransportOnly, existingProviderAccountId: 'max-account-b' }), true, 'a MAX mismatch label whose accounts agree must block')
assert.equal(channelBlocks(maxIdentity, 'provider_account_unproven', { ...maxTransportOnly, existingProviderAccountId: null }), false, 'a proven MAX unstamped-account collision must not disable the person')
const whatsappIdentity = { id: 'identity-wa', channel: 'whatsapp', externalId: '79990001122@c.us' }
assert.equal(channelBlocks(whatsappIdentity, 'transport_mismatch', { incomingConnectionId: 'slot-b', existingConnectionId: 'slot-a' }), false, 'a proven WhatsApp slot collision must not disable the person')
assert.equal(channelBlocks(whatsappIdentity, 'transport_mismatch', { incomingConnectionId: 'slot-a', existingConnectionId: 'slot-a' }), true, 'a WhatsApp mismatch label whose slots agree must block')
assert.equal(channelBlocks(whatsappIdentity, 'transport_unbound', { incomingConnectionId: 'slot-a', existingConnectionId: 'slot-b' }), true, 'a WhatsApp unbound label with a stored slot must block')
assert.equal(channelBlocks(probeIdentity, 'transport_connection_mismatch', { ...botTransportOnly.details, existingConnectionId: botTransportOnly.details.incomingConnectionId }), true, 'a Telegram mismatch label whose connections agree must block')

// The vocabulary is exact: every transport reason any writer ever raised is
// transport-class on its own channel, and every person reason the current writers
// raise is not, on any channel.
const transportReasons = {
    telegram: ['transport_connection_mismatch', 'transport_connection_unproven', 'provider_account_mismatch', 'provider_account_unproven'],
    whatsapp: ['transport_mismatch', 'transport_unbound'],
    max: ['provider_account_mismatch', 'provider_account_unproven'],
}
const personReasons = [
    'channel_mismatch', 'conversation_key_mismatch', 'peer_identity_mismatch', 'chat_kind_mismatch',
    'message_chat_mismatch', 'sender_identity_mismatch', 'sender_identity_unproven',
]
for (const channel of ['telegram', 'whatsapp', 'max']) {
    for (const reason of [...new Set([...Object.values(transportReasons).flat(), ...personReasons])]) {
        assert.equal(
            evidenceState.isTransportCollisionReasonV1(channel, reason),
            transportReasons[channel].includes(reason),
            `${channel} ${reason} transport classification`,
        )
    }
}

// M2-0: route or admission uncertainty on MAX is not a fact about the person.
// Stored MAX conversation facts are peer evidence only when the admission chain
// wrote them for the same concrete account with a private kind. One Contacts
// classifier decides it for the ingress and for the writer. Executed: a body that
// lets legacy or another account's stored facts through, or that stops recording
// a contradiction of proven private peer evidence, fails.
assert.match(evidenceStateSource, /export function isPersonIdentityCollisionEvidenceV1\(/)
assert.equal(typeof evidenceState.isPersonIdentityCollisionEvidenceV1, 'function', 'the Contacts person-evidence classifier is missing')
const maxProvenPrivate = {
    incomingProviderAccountId: 'max-account-b', existingProviderAccountId: 'max-account-b',
    incomingSenderId: 'sender-42', existingSenderId: 'sender-99', incomingChatKind: 'private', existingChatKind: 'private',
}
// [reason, details, person evidence?] — the exact MAX vocabulary the classifier must reproduce.
const maxEvidenceTable = [
    ['sender_identity_mismatch', maxProvenPrivate, true],
    ['chat_kind_mismatch', { ...maxProvenPrivate, existingSenderId: 'sender-42', incomingChatKind: 'group' }, true],
    ['sender_identity_unproven', {}, false],
    ['sender_identity_unproven', maxProvenPrivate, false],
    ['sender_identity_mismatch', { ...maxProvenPrivate, existingProviderAccountId: null, existingChatKind: 'unknown' }, false],
    ['sender_identity_mismatch', { ...maxProvenPrivate, existingProviderAccountId: 'canary-operator-label', existingChatKind: 'unknown' }, false],
    ['sender_identity_mismatch', { ...maxProvenPrivate, existingChatKind: 'unknown' }, false],
    ['sender_identity_mismatch', { ...maxProvenPrivate, existingChatKind: 'group' }, false],
    ['sender_identity_mismatch', { ...maxProvenPrivate, existingProviderAccountId: 'max-account-a' }, false],
    ['sender_identity_mismatch', { ...maxProvenPrivate, existingProviderAccountId: 'legacy', incomingProviderAccountId: 'legacy' }, false],
    ['sender_identity_mismatch', { ...maxProvenPrivate, existingProviderAccountId: 'max-default', incomingProviderAccountId: 'max-default' }, false],
    ['sender_identity_mismatch', { ...maxProvenPrivate, existingProviderAccountId: '  ', incomingProviderAccountId: '  ' }, false],
    ['sender_identity_mismatch', { ...maxProvenPrivate, existingSenderId: null }, false],
    ['sender_identity_mismatch', { ...maxProvenPrivate, incomingSenderId: ' ' }, false],
    ['sender_identity_mismatch', { ...maxProvenPrivate, incomingSenderId: 'sender-99' }, false],
    ['sender_identity_mismatch', { ...maxProvenPrivate, existingSenderId: 'max-account-b' }, false],
    ['sender_identity_mismatch', { ...maxProvenPrivate, incomingSenderId: 'max-account-b' }, false],
    ['sender_identity_mismatch', {}, false],
    ['chat_kind_mismatch', { ...maxProvenPrivate, existingChatKind: 'unknown', incomingChatKind: 'group' }, false],
    ['chat_kind_mismatch', { ...maxProvenPrivate, existingProviderAccountId: null, existingChatKind: 'unknown', incomingChatKind: 'group' }, false],
    ['chat_kind_mismatch', { ...maxProvenPrivate, existingProviderAccountId: 'max-account-a', incomingChatKind: 'group' }, false],
    ['chat_kind_mismatch', { ...maxProvenPrivate, existingChatKind: 'group', incomingChatKind: 'private' }, false],
    ['chat_kind_mismatch', {}, false],
    ['message_chat_mismatch', maxProvenPrivate, false],
    ['channel_mismatch', maxProvenPrivate, false],
    ['conversation_key_mismatch', maxProvenPrivate, false],
    ['peer_identity_mismatch', maxProvenPrivate, false],
    ['provider_account_mismatch', maxProvenPrivate, false],
    ['provider_account_unproven', maxProvenPrivate, false],
]
const personEvidence = (channel, reason, details) => evidenceState.isPersonIdentityCollisionEvidenceV1({ channel, reason, details })
for (const [reason, details, expected] of maxEvidenceTable) {
    assert.equal(personEvidence('max', reason, details), expected, `max ${reason} person evidence for ${JSON.stringify(details)}`)
}
for (const details of [null, [], 'details']) {
    assert.equal(personEvidence('max', 'sender_identity_mismatch', details), false, 'unrecorded MAX details must never be person evidence')
}
assert.equal(personEvidence('sms', 'chat_kind_mismatch', {}), false, 'an unknown channel must never be person evidence')
assert.equal(personEvidence('max', null, maxProvenPrivate), false, 'a missing reason must never be person evidence')
for (const [channel, reasons] of Object.entries(transportReasons)) {
    for (const reason of reasons) {
        assert.equal(personEvidence(channel, reason, maxProvenPrivate), false, `${channel} ${reason} must never be person evidence`)
    }
}
for (const channel of ['telegram', 'whatsapp']) {
    for (const reason of personReasons) {
        assert.equal(personEvidence(channel, reason, {}), true, `${channel} ${reason} must stay person evidence`)
    }
}
// The reader is deliberately unchanged: an open MAX entry written before M2-0 still blocks.
for (const reason of ['sender_identity_unproven', 'sender_identity_mismatch', 'message_chat_mismatch']) {
    assert.equal(channelBlocks(maxIdentity, reason, { ...maxProvenPrivate, existingProviderAccountId: null, existingChatKind: 'unknown' }), true, `a historical MAX ${reason} entry must still block`)
}

// The MAX ingress hands its exact recorded values to that classifier before the
// writer, passes the writer the same values, offers no candidate for a deletion,
// and keeps no evidence taxonomy of its own. It reaches the classifier through the
// Contacts barrel, and its tests wire the real classifier into that barrel mock.
const maxIngressSource = read('gravity-mvp/src/app/api/webhooks/max/route.ts')
const maxCollisionPersistence = maxIngressSource.slice(
    maxIngressSource.indexOf('const persistMaxIdentityCollision'),
    maxIngressSource.indexOf('const rejectExistingChatCollision'),
)
assert.match(maxIngressSource, /import \{\n  isPersonIdentityCollisionEvidenceV1,\n  markChannelIdentityConflictV1,\n  startMaxContactResolutionShadowV1,\n  type LegacyContactResolutionOutcome,\n\} from '@\/modules\/contacts\/public\/v1'\n/)
assert.doesNotMatch(maxIngressSource, /(?:function|const|let)\s+isPersonIdentityCollisionEvidenceV1\b|contacts\/public\/v1\/contact-evidence-state/, 'the MAX ingress must use the Contacts barrel classifier')
assert.match(read('gravity-mvp/src/modules/contacts/public/v1/index.ts'), /\nexport \{ isPersonIdentityCollisionEvidenceV1 \} from '\.\/contact-evidence-state'\n/)
assert.match(read('gravity-mvp/src/app/api/webhooks/max/route.test.ts'), /isPersonIdentityCollisionEvidenceV1: \(\n\s+await vi\.importActual<typeof import\('@\/modules\/contacts\/public\/v1\/contact-evidence-state'\)>\(\n\s+'@\/modules\/contacts\/public\/v1\/contact-evidence-state',\n\s+\)\n\s+\)\.isPersonIdentityCollisionEvidenceV1,/, 'MAX ingress tests must execute the real classifier')
assert.match(maxCollisionPersistence, /const conflictDetails = \{\n\s+incomingProviderAccountId: evidence\.incomingProviderAccountId,\n\s+existingProviderAccountId: evidence\.existingProviderAccountId,\n\s+incomingSenderId: evidence\.incomingSenderId,\n\s+existingSenderId: evidence\.existingSenderId,\n\s+incomingChatKind: evidence\.incomingChatKind,\n\s+existingChatKind: evidence\.existingChatKind,\n\s+\}/)
assert.match(maxCollisionPersistence, /\n\s+if \(\n\s+personReason\n\s+&& existingChat\.contactId\n\s+&& existingChat\.contactIdentityId\n\s+&& isPersonIdentityCollisionEvidenceV1\(\{ channel: 'max', reason: personReason, details: conflictDetails \}\)\n\s+\) \{\n\s+await markChannelIdentityConflictV1\(\{/)
assert.match(maxCollisionPersistence, /reason: personReason,\n\s+evidenceRoot: [^\n]+\n\s+details: conflictDetails,\n\s+\}\)/)
assert.equal(maxCollisionPersistence.match(/markChannelIdentityConflictV1\(/g)?.length, 1, 'the MAX ingress gained an ungated person-conflict write')
assert.match(maxIngressSource, /const existingProviderAccountId = concreteProviderAccountId\(existingMetadata\)\n/)
assert.match(maxIngressSource, /const existingChatKind = existingMetadata\.chatKind === 'private' \|\| existingMetadata\.chatKind === 'group'\n\s+\? existingMetadata\.chatKind\n\s+: 'unknown'\n/)
assert.match(maxIngressSource, /const personReason = deleted \|\| isOutgoing\n\s+\? null\n\s+: providerCollisionReason && collisionReason === providerCollisionReason\n/)
// The classifier's proof rests on how this chain writes the facts it later reads:
// the stored kind and sender are written together, from the same admitted event.
assert.match(maxIngressSource, /\.\.\.\(peerSenderIdString\s+\? \{ senderId: peerSenderIdString \}\s+: \{\}\),\n[\s\S]{0,200}?chatKind: maxChatKind,\n\s+providerAccountId: maxProviderAccountId,\n/)
assert.match(maxIngressSource, /\.\.\.\(peerSenderIdString\s+\? \{ senderId: peerSenderIdString \}\s+: \{\}\),\n[\s\S]{0,240}?chatKind: maxChatKind,\n\s+providerAccountId: maxProviderAccountId,\n\s+connectionId: existingMetadata\.connectionId \|\| 'max_scraper',\n/)
assert.doesNotMatch(maxIngressSource, /chatKind: 'private'|chatKind: existingChatKind|senderId: existingSenderId/, 'the MAX ingress must not fabricate the facts the classifier treats as proof')
assert.equal(maxIngressSource.match(/persistMaxIdentityCollision\(/g)?.length, 1, 'the MAX ingress gained another collision persistence path')
assert.doesNotMatch(maxIngressSource, /personReason\s*[!=]==|new Set\(\[[^\]]*_mismatch'|(?:_mismatch|_unproven)'\s*\]\.includes/, 'the MAX ingress re-derives person evidence locally')

// A provider alias names the person globally on its channel. Neither admission
// nor collision discovery may consult the identity's first-writer account stamp:
// the admission gate refused every unstamped identity, and the candidate filter
// hid another Contact that already owns the alias.
const phoneEvidenceSource = read('gravity-mvp/src/modules/contacts/public/v1/contact-phone-evidence.ts')
const aliasAttach = phoneEvidenceSource.slice(
    phoneEvidenceSource.indexOf('export async function attachProviderIdentityAliasV1('),
    phoneEvidenceSource.indexOf("if (result.status === 'collision') throw new Error('IDENTITY_ALIAS_COLLISION')"),
)
assert(aliasAttach.length > 0, 'provider alias attachment capability not found')
assert.match(aliasAttach, /if \(!identity\n\s+\|\| !identity\.isActive\n\s+\|\| identity\.channel !== command\.channel\) \{\n\s+throw new Error\('IDENTITY_ALIAS_SCOPE_MISMATCH'\)/)
assert.match(aliasAttach, /const collision = candidates\.find\(candidate => candidate\.contactId !== identity\.contactId\)/)
assert.match(aliasAttach, /const sameContactPrimary = candidates\.find\(/)
// The collision entry still records command.providerAccountId as telemetry and uses it
// to de-duplicate entries; only the identity stamp may not be consulted.
assert.doesNotMatch(aliasAttach, /identityEvidenceState\([^)]*\)\.providerAccountId|metadata\)?\.providerAccountId\s*(?:!==|===)/)

// Contacts refuses to record any transport-class reason as a person conflict,
// whatever the caller. The writer is executed with its ownership transaction
// stubbed: a transport reason must be refused before the transaction opens, and a
// person reason must reach it.
const conflictWriterSource = read('gravity-mvp/src/modules/contacts/public/v1/channel-identity-conflict.ts')
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const evidenceStateUrl = moduleUrl(ts.transpileModule(evidenceStateSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText)
const ownershipStubUrl = moduleUrl([
    "export const runContactOwnershipTransaction = async () => { throw new Error('OWNERSHIP_TRANSACTION_REACHED') }",
    'export const lockContactOwnershipRows = async () => ({})',
    'export const assertContactOwnershipPostconditions = async () => undefined',
].join('\n'))
const conflictWriterJs = ts.transpileModule(conflictWriterSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const conflictWriterImports = [...conflictWriterJs.matchAll(/from '([^']+)'/g)].map((match) => match[1]).sort()
assert.deepEqual(conflictWriterImports, ['../../internal/contact-ownership-coordinator', './contact-evidence-state'], 'the conflict writer gained an unreviewed runtime import')
const conflictWriter = await import(moduleUrl(conflictWriterJs
    .replace("from '../../internal/contact-ownership-coordinator'", `from '${ownershipStubUrl}'`)
    .replace("from './contact-evidence-state'", `from '${evidenceStateUrl}'`)))
const writerOutcome = async (channel, reason, details = {}) => {
    try {
        await conflictWriter.markChannelIdentityConflictV1({
            contactId: 'contact-probe', identityId: 'identity-probe', channel, reason,
            evidenceRoot: `channel-collision:${channel}:probe:${reason}`, details,
        })
        return 'RESOLVED'
    } catch (error) {
        return error?.message
    }
}
for (const [channel, reasons] of Object.entries(transportReasons)) {
    for (const reason of reasons) {
        assert.equal(await writerOutcome(channel, reason), 'transport collision is not a person identity conflict', `the writer must refuse ${channel} ${reason}`)
    }
}
for (const reason of personReasons) {
    assert.equal(await writerOutcome('telegram', reason), 'OWNERSHIP_TRANSACTION_REACHED', `the writer must record telegram ${reason}`)
}
// The writer holds no taxonomy of its own: for every recorded MAX shape it refuses
// or records exactly as the executed classifier decides.
const unprovenPersonRefusal = 'collision evidence does not prove a person identity conflict'
for (const [reason, details, expected] of maxEvidenceTable) {
    assert.equal(
        await writerOutcome('max', reason, details),
        evidenceState.isTransportCollisionReasonV1('max', reason)
            ? 'transport collision is not a person identity conflict'
            : expected ? 'OWNERSHIP_TRANSACTION_REACHED' : unprovenPersonRefusal,
        `the writer must follow the classifier for max ${reason} ${JSON.stringify(details)}`,
    )
}
assert.match(conflictWriterSource, /\n\s+if \(!isPersonIdentityCollisionEvidenceV1\(input\)\) \{\n\s+throw new TypeError\('collision evidence does not prove a person identity conflict'\)\n\s+\}\n\}/)
assert.doesNotMatch(conflictWriterSource, /sender_identity_|chat_kind_mismatch|message_chat_mismatch|existingChatKind|existingSenderId|existingProviderAccountId/, 'the conflict writer re-derives person evidence locally')

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
