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

const contract = read('gravity-mvp/src/contracts/contacts/v1/resolve-contact-command.ts')
const handler = read('gravity-mvp/src/modules/contacts/public/v1/resolve-contact-handler.ts')
const policy = read('gravity-mvp/src/modules/contacts/public/v1/legacy-contact-name-policy.ts')
const adapter = read('gravity-mvp/src/modules/contacts/public/v1/legacy-prisma-contact-adapter.ts')
const consumer = read('gravity-mvp/src/app/api/webhooks/max/route.ts')
const retiredNameSync = read('gravity-mvp/src/app/api/webhook/max/sync-names/route.ts')
const contactsManifest = JSON.parse(read('architecture/contexts/v1/manifests/contacts.json'))
const maxManifest = JSON.parse(read('architecture/contexts/v1/manifests/max_channel.json'))

assertCheck(
    'Contacts contract is framework, persistence and provider neutral',
    !/(?:@\/lib|next\/|@prisma|prisma|telegram|whatsapp|max-actions|freeswitch)/i.test(contract),
    'contract contains an implementation dependency',
)
assertCheck(
    'Contacts handler depends only on the versioned contract',
    handler.includes("from '../../../../contracts/contacts/v1'")
        && !/(?:@\/lib|next\/|@prisma|prisma)/i.test(handler),
    'owner handler leaks an implementation dependency',
)
assertCheck(
    'Contact persistence is isolated to the owner adapter',
    adapter.includes("from '@/lib/prisma'")
        && adapter.includes('prisma.contact.findUnique')
        && adapter.includes('prisma.contact.update')
        && !/prisma\.contact\.(?:create|update|upsert|delete|updateMany)\s*\(/.test(consumer)
        && !/prisma\.contact\.(?:create|update|upsert|delete|updateMany)\s*\(/.test(retiredNameSync),
    'MAX consumer retains a direct Contact mutation',
)
assertCheck(
    'canonical MAX consumer invokes the Contacts public resolution capability',
    consumer.includes("from '@/modules/contacts/public/v1'")
        && consumer.includes("resolveChannelContactOperationV1(")
        && consumer.includes("'max',")
        && consumer.includes('providerAccountId: maxProviderAccountId'),
    'MAX consumer bypasses the Contacts public v1 surface',
)
assertCheck(
    'candidate name crosses without provider implementation data',
    consumer.includes('peerSenderName,')
        && consumer.includes("phoneEvidence: effectivePeerSenderPhone")
        && consumer.includes("source: 'unknown', trustedForAutomaticResolution: false")
        && !/(token|cookie|session|credential)/i.test(contract),
    'public contract includes credential or provider implementation state',
)
assertCheck(
    'owner preserves missing and useful-name no-op outcomes',
    adapter.includes("if (!contact) return 'not_found'")
        && adapter.includes("return 'preserved'"),
    'legacy no-op behavior is incomplete',
)
assertCheck(
    'placeholder update remains conditional',
    adapter.indexOf('isLegacyPlaceholderContactNameV1') < adapter.indexOf('prisma.contact.update'),
    'Contact update can bypass placeholder policy',
)
assertCheck(
    'legacy placeholder patterns remain represented',
    policy.includes('TG|MAX|WA|Telegram|Max|WhatsApp')
        && policy.includes('^\\d+$')
        && policy.includes('^[.\\s\\-]+$'),
    'placeholder policy drifted',
)
assertCheck(
    'adjacent Chat mutation uses accepted Messaging owner capabilities',
    !consumer.includes('prisma.chat.update')
        && !consumer.includes('prisma.chat.create')
        && consumer.includes('PATCH_EXTERNAL_CONVERSATION_COMMAND_V1')
        && consumer.includes('patchExternalConversationV1({')
        && consumer.includes('CREATE_EXTERNAL_CONVERSATION_COMMAND_V1')
        && consumer.includes('createExternalConversationV1({'),
    'MAX Chat mutation bypasses the accepted Messaging owner route',
)
assertCheck(
    'mutable MAX name-sync ingress is statically retired',
    retiredNameSync.includes('MAX_NAME_SYNC_RETIRED')
        && !retiredNameSync.includes('await req.json')
        && !retiredNameSync.includes('prisma.'),
    'retired MAX name-sync can still parse or mutate',
)
assertCheck(
    'Contacts manifest declares ResolveContactCommand.v1',
    contactsManifest.commands.includes('ResolveContactCommand.v1'),
    'Contacts command was not previously declared',
)
assertCheck(
    'MAX to Contacts dependency is already allowed',
    maxManifest.allowed_dependencies.some((dependency) => dependency.context === 'contacts'),
    'MAX context lacks the accepted Contacts dependency',
)
assertCheck(
    'contract identifier cannot silently change version',
    contract.includes("'contacts.ResolveContactCommand.v1'"),
    'expected v1 semantic identifier is absent',
)

process.stdout.write(`${JSON.stringify({ status: failures.length === 0 ? 'PASS' : 'FAIL', checks, failures }, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
