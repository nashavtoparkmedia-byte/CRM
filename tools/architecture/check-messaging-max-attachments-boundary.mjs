#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const checks = []
const failures = []
const check = (name, value, detail) => value ? checks.push(name) : failures.push({ check: name, detail })
const attachV2 = read('gravity-mvp/src/contracts/messaging/v2/attach-message-media-command.ts')
const deleteV1 = read('gravity-mvp/src/contracts/messaging/v1/delete-message-media-command.ts')
const attachHandler = read('gravity-mvp/src/modules/messaging/public/v2/attach-message-media-handler.ts')
const deleteHandler = read('gravity-mvp/src/modules/messaging/public/v1/delete-message-media-handler.ts')
const attachAdapter = read('gravity-mvp/src/modules/messaging/public/v2/legacy-prisma-attach-message-media-adapter.ts')
const deleteAdapter = read('gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-delete-message-media-adapter.ts')
const consumer = read('gravity-mvp/src/app/api/webhooks/max/route.ts')
const max = JSON.parse(read('architecture/contexts/v1/manifests/max_channel.json'))
const amendment = JSON.parse(read('architecture/isolation/messaging/max-attachments-v2/module-manifest-amendments.json'))

check('accepted attach v1 remains byte-identical', sha('gravity-mvp/src/contracts/messaging/v1/attach-message-media-command.ts') === '3991133df680329f3e0d2e9ce950e04f15a1ed164f0c2359158b0687cf40ed35', 'accepted v1 drifted')
check('attach v2 is provider neutral', !/(max|prisma|next\/|@\/lib|@\/app)/i.test(attachV2), 'implementation leaked into v2')
check('delete v1 is provider neutral', !/(max|prisma|next\/|@\/lib|@\/app)/i.test(deleteV1), 'implementation leaked into delete contract')
check('handlers are implementation neutral', !/(max|prisma|next\/|@\/lib|@\/app)/i.test(attachHandler + deleteHandler), 'implementation leaked into handler')
check('writes are isolated in Messaging adapters', attachAdapter.includes('prisma.messageAttachment.create') && deleteAdapter.includes('prisma.messageAttachment.deleteMany') && !/prisma\.messageAttachment\.(?:create|deleteMany)/.test(consumer), 'foreign attachment write remains')
check('MAX invokes nullable attach v2', consumer.includes('ATTACH_MESSAGE_MEDIA_COMMAND_V2') && consumer.includes('attachMessageMediaV2({'), 'attach v2 absent')
check('MAX invokes delete media v1', consumer.includes('DELETE_MESSAGE_MEDIA_COMMAND_V1') && consumer.includes('deleteMessageMediaV1({'), 'delete v1 absent')
check('attachments delete before message', consumer.indexOf('await deleteMessageMediaV1') < consumer.indexOf('await prisma.message.delete'), 'delete order drifted')
check('attachment mapping retained', ['messageId: message.id', "mediaType: att.type || 'file'", 'url: att.url', 'fileName: attachmentDisplayName(att)', 'fileSize: attachmentSize(att)', 'mimeType: att.mimeType || null'].every((value) => consumer.includes(value)), 'create mapping drifted')
check('existing URL dedup retained', consumer.includes('prisma.messageAttachment.findMany') && consumer.includes('if (seenUrls.has(att.url)) continue') && consumer.includes('seenUrls.add(att.url)'), 'dedup drifted')
check('missing URLs remain skipped', consumer.includes('if (!att.url) continue'), 'URL guard drifted')
check('command amendment exact', amendment.amendments.length === 1 && amendment.amendments[0].context === 'messaging' && JSON.stringify(amendment.amendments[0].add_commands) === JSON.stringify(['AttachMessageMediaCommand.v2', 'DeleteMessageMediaCommand.v1']), 'command amendment drifted')
check('MAX Messaging dependency pre-approved', max.allowed_dependencies.some((item) => item.context === 'messaging' && item.surface === 'messaging.public'), 'approved dependency absent')
check('neighboring Message and Chat writes remain explicit', /prisma\.message\.(?:create|delete)/.test(consumer) && /prisma\.chat\.(?:create|update)/.test(consumer), 'neighboring plan unexpectedly moved')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
