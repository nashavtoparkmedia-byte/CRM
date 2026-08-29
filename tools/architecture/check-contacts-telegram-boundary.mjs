#!/usr/bin/env node
import fs from 'node:fs'
const read = (file) => fs.readFileSync(file, 'utf8')
const failures = [], checks = []
const check = (name, ok, detail) => ok ? checks.push(name) : failures.push({ check: name, detail })
const contract = read('gravity-mvp/src/contracts/contacts/v1/attach-contact-identity-command.ts')
const handler = read('gravity-mvp/src/modules/contacts/public/v1/attach-contact-identity-handler.ts')
const adapter = read('gravity-mvp/src/modules/contacts/public/v1/legacy-prisma-contact-identity-adapter.ts')
const consumer = read('gravity-mvp/src/app/api/webhook/telegram/route.ts')
const contacts = JSON.parse(read('architecture/contexts/v1/manifests/contacts.json'))
const telegram = JSON.parse(read('architecture/contexts/v1/manifests/telegram_channel.json'))
check('contract is provider and persistence neutral', !/(telegram|prisma|@\/lib|next\/)/i.test(contract), 'implementation leaked')
check('handler depends only on Contacts v1 contract', handler.includes("from '../../../../contracts/contacts/v1'") && !/(prisma|@\/lib|next\/)/i.test(handler), 'handler leaked implementation')
check('identity write is isolated to Contacts adapter', adapter.includes('prisma.contactIdentity.update') && !/prisma\.contactIdentity\.update\s*\(/.test(consumer), 'foreign write remains')
check('Telegram invokes public v1 command', consumer.includes('ATTACH_CONTACT_IDENTITY_COMMAND_V1') && consumer.includes('attachContactIdentityV1({'), 'public call absent')
check('public profile names are provider neutral', ['handle', 'givenName', 'familyName'].every((v) => contract.includes(v)) && !contract.includes('username'), 'provider keys leaked')
check('legacy metadata mapping stays in adapter', adapter.includes('username: handle') && adapter.includes('firstName: givenName') && adapter.includes('lastName: familyName'), 'legacy mapping drifted')
check('legacy null coercion remains in caller', consumer.includes('handle: username || null') && consumer.includes('givenName: firstName || null') && consumer.includes('familyName: lastName || null'), 'null behavior drifted')
check('Contacts declares AttachContactIdentityCommand.v1', contacts.commands.includes('AttachContactIdentityCommand.v1'), 'manifest command absent')
check('Telegram dependency on Contacts is allowed', telegram.allowed_dependencies.some((d) => d.context === 'contacts'), 'dependency absent')
check('neighboring Contact resolution remains explicit through public v2', consumer.includes('RESOLVE_CONTACT_COMMAND_V2') && consumer.includes('resolveContactV2({'), 'channel-name owner boundary absent')
process.stdout.write(`${JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks, failures }, null, 2)}\n`)
if (failures.length) process.exitCode = 1
