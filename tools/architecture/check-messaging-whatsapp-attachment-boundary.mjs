#!/usr/bin/env node
import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value ? checks.push(name) : failures.push({ check: name, detail })
const contract = read('gravity-mvp/src/contracts/messaging/v1/attach-message-media-command.ts')
const handler = read('gravity-mvp/src/modules/messaging/public/v1/attach-message-media-handler.ts')
const adapter = read('gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-attach-message-media-adapter.ts')
const consumer = read('gravity-mvp/src/lib/whatsapp/WhatsAppService.ts')
const messaging = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
const whatsapp = JSON.parse(read('architecture/contexts/v1/manifests/whatsapp_channel.json'))

check('contract is provider neutral', !/(whatsapp|prisma|next\/|@\/lib|@\/app)/i.test(contract), 'implementation leaked into contract')
check('handler is implementation neutral', !/(whatsapp|prisma|next\/|@\/lib|@\/app)/i.test(handler), 'implementation leaked into handler')
check('write is isolated in Messaging adapter', adapter.includes('prisma.messageAttachment.create') && !/prisma\.messageAttachment\.create/.test(consumer), 'foreign write remains')
check('attachment mapping exact', ['messageId: input.messageId', 'type: input.mediaType', 'url: input.url', 'fileName: input.fileName', 'fileSize: input.fileSize', 'mimeType: input.mimeType'].every((value) => adapter.includes(value)), 'attachment mapping drifted')
check('WhatsApp invokes AttachMessageMedia v1', consumer.includes('ATTACH_MESSAGE_MEDIA_COMMAND_V1') && consumer.includes('attachMessageMediaV1({'), 'owner command absent')
check('download and missing-media guard retained', consumer.indexOf('await msgObj.downloadMedia()') < consumer.indexOf('if (!media || !media.data) return false'), 'download guard drifted')
check('size limit remains before persistence', consumer.indexOf('base64Bytes > MAX_MEDIA_SIZE_BYTES') < consumer.indexOf('await attachMessageMediaV1'), 'size guard drifted')
check('data URL retained', consumer.includes('`data:${media.mimetype};base64,${media.data}`'), 'data URL drifted')
check('nullable metadata coercion retained', consumer.includes('fileName: media.filename || null') && consumer.includes('mimeType: media.mimetype || null'), 'nullable metadata drifted')
check('success log and return retained', consumer.indexOf('[WA-MEDIA] ${logCtx} saved:') > consumer.indexOf('await attachMessageMediaV1') && consumer.includes('return true'), 'success behavior drifted')
check('nonfatal catch retained', consumer.includes('[WA-MEDIA] ${logCtx} download failed:') && consumer.includes('return false'), 'failure behavior drifted')
check('AttachMessageMedia command predeclared', messaging.commands.includes('AttachMessageMediaCommand.v1'), 'manifest command absent')
check('WhatsApp Messaging dependency pre-approved', whatsapp.allowed_dependencies.some((item) => item.context === 'messaging' && item.surface === 'messaging.public'), 'approved dependency absent')
check('provider transport remains in WhatsApp', consumer.includes("from 'whatsapp-web.js'") && consumer.includes('msgObj.downloadMedia()'), 'provider transport drifted')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
