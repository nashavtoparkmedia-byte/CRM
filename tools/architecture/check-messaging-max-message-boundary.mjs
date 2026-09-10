#!/usr/bin/env node

import fs from 'node:fs'

const read = file => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value
    ? checks.push(name)
    : failures.push({ check: name, detail })

const contract = read('gravity-mvp/src/contracts/messaging/v1/external-message-commands.ts')
const handler = read('gravity-mvp/src/modules/messaging/public/v1/external-message-handler.ts')
const adapter = read('gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-external-message-adapter.ts')
const consumer = read('gravity-mvp/src/app/api/webhooks/max/route.ts')
const collisionCapability = read('gravity-mvp/src/modules/messaging/public/v1/conversation-identity-collision.ts')
const amendment = JSON.parse(read('architecture/isolation/messaging/max-message-v1/module-manifest-amendments.json'))

const deleted = consumer.slice(
    consumer.indexOf('if (deleted) {'),
    consumer.indexOf('if (isTextProviderEvent && externalIdString)'),
)
const textDedupe = consumer.slice(
    consumer.indexOf('if (isTextProviderEvent && externalIdString)'),
    consumer.indexOf('if (peerSenderIdString)'),
)
const upgrade = consumer.slice(
    consumer.indexOf('if (shouldUpgradeDomMessage)'),
    consumer.indexOf('const isDomFallbackMedia'),
)
const create = consumer.slice(
    consumer.indexOf('// Create Message'),
    consumer.indexOf('// Save attachments'),
)
const collisionPersistence = consumer.slice(
    consumer.indexOf('const persistMaxIdentityCollision'),
    consumer.indexOf('const rejectExistingChatCollision'),
)

check('contract neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(contract), 'contract leak')
check('handler neutral', !/(prisma|next\/|@\/lib|@\/app)/i.test(handler), 'handler leak')
check(
    'writes isolated',
    adapter.includes('prisma.message.delete')
        && adapter.includes('prisma.message.update')
        && adapter.includes('prisma.message.upsert')
        && !consumer.includes('prisma.message.delete')
        && !consumer.includes('prisma.message.update')
        && !consumer.includes('prisma.message.upsert'),
    'foreign write remains',
)
check(
    'delete owner loaded and admitted',
    deleted.includes('include: { chat: true }')
        && deleted.indexOf('rejectExistingChatCollision(existingMessage.chat') < deleted.indexOf('deleteMessageMediaV1'),
    'delete can run before exact owning Chat admission',
)
check(
    'delete order retained',
    deleted.indexOf('deleteMessageMediaV1') < deleted.indexOf('deleteMessageV1')
        && deleted.indexOf('deleteMessageV1') < deleted.indexOf('broadcastChatMessage'),
    'delete order drift',
)
check(
    'delete mapping retained',
    deleted.includes('DELETE_MESSAGE_COMMAND_V1')
        && deleted.includes('messageId: existingMessage.id'),
    'delete mapping drift',
)
check(
    'text dedupe owner admitted',
    textDedupe.includes('include: { chat: true }')
        && textDedupe.indexOf('rejectExistingChatCollision(existingText.chat') < textDedupe.indexOf("maxRuntimeTrace('webhook.duplicate'"),
    'provider-key dedupe can suppress another Chat before admission',
)
check(
    'upgrade search remains caller',
    upgrade.includes('prisma.message.findFirst')
        && upgrade.includes("externalId: { startsWith: 'max-dom-' }")
        && upgrade.includes('10 * 60 * 1000'),
    'upgrade search drift',
)
check(
    'upgrade mapping retained',
    upgrade.includes('messageId: nearbyDomMessage.id')
        && upgrade.includes('externalId: externalIdString')
        && upgrade.includes('type: msgType')
        && upgrade.includes('metadata: { ...metadataRecord(nearbyDomMessage.metadata)'),
    'upgrade mapping drift',
)
check(
    'replace adapter exact',
    adapter.includes('update({where:{id:input.messageId},data:{externalId:input.externalId,type:input.type,content:input.content,sentAt:input.sentAt,metadata:input.metadata'),
    'replace drift',
)
check(
    'upsert owner proven before workflow',
    create.indexOf('upsertExternalMessageV1') < create.indexOf('if (message.chatId !== chat.id)')
        && create.indexOf('if (message.chatId !== chat.id)') < create.indexOf('ConversationWorkflowService.onInboundMessage'),
    'workflow can run before the globally keyed Message owner is proven',
)
check(
    'fallback key retained',
    create.includes('externalIdString || `max-${chatId}-${Date.now()}`'),
    'fallback key drift',
)
check(
    'upsert mapping retained',
    create.includes('chatId: chat.id')
        && create.includes("direction: isOutgoing ? 'outbound' : 'inbound'")
        && create.includes("channel: 'max'")
        && create.includes('externalId: externalIdString')
        && create.includes('sentAt, // validated above'),
    'upsert mapping drift',
)
check(
    'upsert adapter exact',
    adapter.includes('upsert({where:{externalId:input.lookupExternalId},update:{},create:{')
        && adapter.includes("status:'delivered'"),
    'upsert drift',
)
check(
    'collision evidence is atomic and precedes hard conflict',
    collisionCapability.includes('$transaction(async transaction =>')
        && collisionCapability.includes('FOR UPDATE')
        && collisionPersistence.indexOf('appendConversationIdentityCollisionV1') < collisionPersistence.indexOf('markChannelIdentityConflictV1'),
    'collision audit is not atomic or hard conflict precedes durable evidence',
)
check(
    'post persistence retained',
    consumer.indexOf('// Save attachments') < consumer.lastIndexOf('emitMessageReceived(message)')
        && consumer.includes('messageId: message.id'),
    'continuation drift',
)
check(
    'commands amendment exact',
    amendment.amendments.length === 1
        && amendment.amendments[0]?.context === 'messaging'
        && JSON.stringify(amendment.amendments[0]?.add_commands) === JSON.stringify([
            'DeleteMessageCommand.v1',
            'ReplaceExternalMessageCommand.v1',
            'UpsertExternalMessageCommand.v1',
        ]),
    'amendment drift',
)

process.stdout.write(`${JSON.stringify({
    status: failures.length ? 'FAIL' : 'PASS',
    checks,
    failures,
}, null, 2)}\n`)
if (failures.length) process.exitCode = 1
