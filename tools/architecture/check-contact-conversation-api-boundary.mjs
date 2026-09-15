#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const failures = []
const checks = []
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const assertCheck = (name, condition, detail) => {
    if (condition) checks.push(name)
    else failures.push({ check: name, detail })
}

const routes = [
    'gravity-mvp/src/app/api/contacts/start-conversation/route.ts',
    'gravity-mvp/src/app/api/contacts/[id]/chats/route.ts',
    'gravity-mvp/src/app/api/contacts/[id]/parks/route.ts',
]
const moduleRules = JSON.parse(read('architecture/evidence/v1/module-rules.json'))
const compiledRules = moduleRules.modules.map((rule) => ({ ...rule, regex: new RegExp(rule.match) }))
const classifications = routes.map((file) => compiledRules.find((rule) => rule.regex.test(file))?.id ?? null)
const exactOverride = compiledRules.find((rule, index) =>
    rule.id === 'gravity_core'
    && index < compiledRules.findIndex((candidate) => candidate.id === 'contacts')
    && routes.every((file) => rule.regex.test(file)))

assertCheck(
    'all contact composition routes classify as Platform Shell gravity_core',
    classifications.every((classification) => classification === 'gravity_core'),
    `classifications were ${JSON.stringify(classifications)}`,
)
assertCheck(
    'the high-priority override is exact to the three composition route files',
    Boolean(exactOverride)
        && [
            'gravity-mvp/src/app/api/contacts/route.ts',
            'gravity-mvp/src/app/api/contacts/start-conversation/not-route.ts',
            'gravity-mvp/src/app/api/contacts/[id]/route.ts',
            'gravity-mvp/src/app/api/contacts/[id]/chats/history/route.ts',
        ].every((file) => !exactOverride.regex.test(file)),
    'override is absent, lower-priority, or matches a wider route family',
)

for (const route of routes) {
    const source = read(route)
    assertCheck(
        `${route} is a Prisma-free Platform adapter`,
        !/@\/lib\/prisma|\bprisma\s*\./.test(source),
        'route retains direct persistence',
    )
}

const parkRoute = read(routes[2])
assertCheck(
    'park check composes only Contacts, Fleet and Platform merge capabilities',
    parkRoute.includes("from '@/modules/contacts/public/v1'")
        && parkRoute.includes("from '@/modules/fleet-operations/public/v1'")
        && parkRoute.includes("from '@/modules/platform-shell/internal/contact-park-merge-orchestrator'")
        && !/@\/modules\/(?:contacts|fleet-operations)\/(?:internal|infrastructure)|legacy-prisma/.test(parkRoute),
    'park route bypasses an owner boundary or imports an owner implementation adapter',
)

const parkMergeOrchestrator = read('gravity-mvp/src/modules/platform-shell/internal/contact-park-merge-orchestrator.ts')
assertCheck(
    'park reconciliation delegates only an exact pair to the locked automatic merge composition',
    parkMergeOrchestrator.includes("from '@/infrastructure/automatic-contact-merge'")
        && parkMergeOrchestrator.includes('attemptAutomaticContactMergeFromPlatformV1')
        && parkMergeOrchestrator.includes('executeAutomaticContactMergeV1({ leftContactId, rightContactId })')
        && !parkMergeOrchestrator.includes("operation: 'contact_to_driver'")
        && !/@\/lib\/ContactMergeService|@\/lib\/prisma|\bprisma\s*\./.test(parkMergeOrchestrator),
    'park reconciliation is broad or bypasses the established locked automatic merge capability',
)

for (const route of routes.slice(0, 2)) {
    const source = read(route)
    assertCheck(
        `${route} delegates conversation composition to Platform Shell`,
        source.includes('@/modules/platform-shell/internal/contact-conversation-orchestrator')
            && !/\bContactService\b/.test(source),
        'contact-conversation route bypasses Platform orchestration',
    )
}

const startRoute = read(routes[0])
const contactRoute = read(routes[1])
assertCheck(
    'start-conversation HTTP compatibility is frozen',
    startRoute.includes("{ error: 'phone and channel are required' }")
        && startRoute.includes("{ error: 'INVALID_PHONE', message: 'Invalid phone number format' }")
        && startRoute.includes("'[contacts/start-conversation] POST Error:'")
        && startRoute.includes('isNew: result.isNewContact')
        && startRoute.includes('isNew: result.isNewConversation'),
    'validation, log prefix, or response projection drifted',
)
assertCheck(
    'contact chats HTTP compatibility is frozen',
    contactRoute.includes("{ error: 'Contact not found' }")
        && contactRoute.includes("{ error: 'Identity not found or does not match contact/channel' }")
        && contactRoute.includes("{ error: 'NO_IDENTITY'")
        && contactRoute.includes("'[contacts/:id/chats] POST Error:'")
        && contactRoute.includes('identityId: identityId ? identityId : null')
        && contactRoute.includes('contactId: id')
        && contactRoute.includes('contactIdentityId: result.identity.id'),
    'status body, log prefix, or response projection drifted',
)

const orchestrator = read('gravity-mvp/src/modules/platform-shell/internal/contact-conversation-orchestrator.ts')
const messagingAdapter = read('gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-contact-conversation-adapter.ts')
assertCheck(
    'Platform composes only versioned Contacts, Fleet and Messaging surfaces',
    orchestrator.includes("from '@/modules/contacts/public/v1'")
        && orchestrator.includes("from '@/modules/fleet-operations/public/v1'")
        && orchestrator.includes("from '@/modules/messaging/public/v1'")
        && !/@\/lib\/prisma|\bContactService\b|\bprisma\s*\./.test(orchestrator),
    'owner implementation leaked into Platform orchestration',
)
// The identity's providerAccountId is first-writer telemetry about the person
// (docs/design/provider-account-identity-v1.md). The versioned Messaging command
// still carries it, but neither Platform nor Messaging may compare a route with
// it, narrow a route search by it, or substitute it for the route's own account.
assertCheck(
    'exact identity fallback is identity-scoped while driver-wide legacy fallback stays unscoped',
    orchestrator.includes('input.identityId === null && input.phoneId === null')
        && orchestrator.includes('const allowContactFallback = true')
        && orchestrator.includes('const allowLegacyDriverFallback = input.identityId === null && input.phoneId === null')
        && orchestrator.includes('allowContactFallback,')
        && orchestrator.includes('if (allowLegacyDriverFallback)')
        && orchestrator.includes('identityExternalId: prepared.identity.externalId')
        && orchestrator.includes('providerAccountId: prepared.identity.providerAccountId')
        && orchestrator.includes("if (opened.status !== 'ready') return { status: opened.status }")
        && orchestrator.includes('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
        && orchestrator.includes('CONTACT_CONVERSATION_BINDING_MISMATCH')
        && !orchestrator.includes('expected.providerAccountId'),
    'Platform can use a broad driver fallback, trust a mismatched Contact binding, or gate a route by the identity account stamp',
)
assertCheck(
    'Messaging backfill requires exact identity ownership, channel target proof, route uniqueness and transport proof, and never gates a route by the identity account stamp',
    messagingAdapter.includes('assertExactConversationTarget(conversation, input)')
        && messagingAdapter.includes('contactIdentityId: input.contactIdentityId, channel: input.channel')
        && messagingAdapter.includes('{ contactIdentityId: null }')
        && messagingAdapter.includes("metadataRecord(conversation.metadata).senderId")
        && messagingAdapter.includes("metadataRecord(conversation.metadata).providerAccountId")
        && messagingAdapter.includes("metadataRecord(conversation.metadata).connectionId")
        && messagingAdapter.includes('CONTACT_CONVERSATION_PROVIDER_KEY_MISMATCH')
        && messagingAdapter.includes('CONTACT_CONVERSATION_OWNERSHIP_MISMATCH')
        && messagingAdapter.includes("throw new Error('CONTACT_CONVERSATION_AMBIGUOUS')")
        && messagingAdapter.includes('const providerAccountId = storedProviderAccountId(conversation)\n')
        && messagingAdapter.includes("return { status: 'conversation_target_unproven' }")
        && messagingAdapter.includes("return { status: 'transport_unbound' }")
        && !messagingAdapter.includes('input.providerAccountId')
        && !messagingAdapter.includes("'provider_account_unproven'")
        && !messagingAdapter.includes('prisma.chat.create('),
    'Messaging can claim or fabricate a conversation whose owner, target or transport differs, or lets the identity account stamp scope, reject or stand in for a route account',
)
// Without the identity-stamp filter, only the two-row read plus the ambiguity
// refusal stops one sender's conversations under two company accounts from
// silently resolving to whichever route saw them first. Every conversation read
// must stay a uniqueCandidate over at most two rows.
const conversationReads = messagingAdapter.match(/await prisma\.chat\.findMany\(/g)?.length ?? 0
assertCheck(
    'every Messaging contact-conversation read is an ambiguity-refusing two-row unique-candidate read',
    conversationReads === 4
        && (messagingAdapter.match(/\bprisma\.|\$queryRaw|\$executeRaw/g)?.length ?? 0) === conversationReads
        && (messagingAdapter.match(/uniqueCandidate\(await prisma\.chat\.findMany\(\{/g)?.length ?? 0) === conversationReads
        && (messagingAdapter.match(/\n\s+take: 2,\n/g)?.length ?? 0) === conversationReads
        && messagingAdapter.includes('const unique = [...new Map(conversations.map(conversation => [conversation.id, conversation])).values()]')
        && /if \(unique\.length > 1\) throw new Error\('CONTACT_CONVERSATION_AMBIGUOUS'\)/.test(messagingAdapter),
    'a conversation read can return one of several routes without refusing the ambiguity',
)

assertCheck(
    'orchestration remains sequential and non-transactional',
    !/Promise\.all|\$transaction|\bcatch\s*\(|\bfor\s*\(|\bwhile\s*\(/.test(orchestrator)
        && orchestrator.indexOf('resolveChannelContactV1({')
            < orchestrator.indexOf('findAndBackfillContactConversationV1({')
        && orchestrator.indexOf('findDriverByExactPhoneV1({')
            < orchestrator.indexOf('openFallbackContactConversationV1({'),
    'parallelism, retry/catch/transaction, or owner-call order changed',
)

const result = {
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    checks,
    failures,
    routes,
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exit(1)
