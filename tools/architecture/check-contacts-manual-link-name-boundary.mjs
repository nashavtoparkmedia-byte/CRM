#!/usr/bin/env node
import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const checks = []
const failures = []
const check = (name, value, detail) => value ? checks.push(name) : failures.push({ check: name, detail })
const contract = read('gravity-mvp/src/contracts/contacts/v1/set-contact-display-name-command.ts')
const handler = read('gravity-mvp/src/modules/contacts/public/v1/set-contact-display-name-handler.ts')
const adapter = read('gravity-mvp/src/modules/contacts/public/v1/legacy-prisma-contact-display-name-adapter.ts')
const consumer = read('gravity-mvp/src/app/messages/link-chat-actions.ts')
const amendment = JSON.parse(read('architecture/isolation/contacts/manual-link-display-name-v1/module-manifest-amendments.json'))
const messaging = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))

check('contract is provider neutral', !/(prisma|next\/|@\/lib)/i.test(contract), 'implementation leaked into contract')
check('handler is provider neutral', !/(prisma|next\/|@\/lib)/i.test(handler), 'implementation leaked into handler')
check('write is isolated in Contacts adapter', adapter.includes('prisma.contact.update') && !/prisma\.contact\.update/.test(consumer), 'foreign write remains')
check('owner existence no-op retained', adapter.includes('prisma.contact.findUnique') && adapter.includes("return 'not_found'"), 'existence guard drifted')
check('Messaging invokes public v1', consumer.includes('SET_CONTACT_DISPLAY_NAME_COMMAND_V1') && consumer.includes('setContactDisplayNameV1({'), 'public command absent')
check('manual-link guard retained', consumer.includes('else if (chat.contactId) {'), 'contact guard drifted')
check('driver name forwarded unchanged', consumer.includes('displayName: driver.fullName'), 'display name drifted')
check('neighboring ContactService flow retained', consumer.includes('ContactService.resolveContact(') && consumer.includes('ContactService.ensureChatLinked('), 'neighboring flow changed')
check('command amendment exact', amendment.amendments[0].context === 'contacts' && amendment.amendments[0].add_commands?.length === 1 && amendment.amendments[0].add_commands[0] === 'SetContactDisplayNameCommand.v1', 'command amendment drifted')
check('Messaging Contacts dependency was pre-approved', messaging.allowed_dependencies.some((item) => item.context === 'contacts' && item.surface === 'contacts.public'), 'approved dependency absent')

process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
