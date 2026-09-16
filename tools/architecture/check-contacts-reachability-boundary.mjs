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

assert.equal(sha256(read(implementationPath)), '7e1d5e57aa744a748b5c6f6e56067bbfa93e30ea5884b73d57a4d5dc6ada19af')

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
