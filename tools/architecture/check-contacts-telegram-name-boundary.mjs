#!/usr/bin/env node
import { createHash } from 'node:crypto'; import fs from 'node:fs'
const read=f=>fs.readFileSync(f,'utf8'), sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex'), failures=[], checks=[]
const check=(n,v,d)=>v?checks.push(n):failures.push({check:n,detail:d})
const contract=read('gravity-mvp/src/contracts/contacts/v2/resolve-contact-command.ts'),handler=read('gravity-mvp/src/modules/contacts/public/v2/resolve-contact-handler.ts'),adapter=read('gravity-mvp/src/modules/contacts/public/v2/legacy-prisma-contact-adapter.ts'),consumer=read('gravity-mvp/src/app/api/webhook/telegram/route.ts'),amend=JSON.parse(read('architecture/isolation/contacts/telegram-channel-name-v2/module-manifest-amendments.json'))
check('v2 contract neutral',!/(telegram|prisma|@\/lib|next\/)/i.test(contract),'implementation leaked')
check('v2 handler neutral',handler.includes("from '../../../../contracts/contacts/v2'")&&!/(prisma|@\/lib|next\/)/i.test(handler),'handler leaked')
check('Contact write owner isolated',adapter.includes('prisma.contact.update')&&!/prisma\.contact\.update\s*\(/.test(consumer),'foreign write remains')
check('channel authority checked before update',adapter.indexOf("displayNameSource !== 'channel'")<adapter.indexOf('prisma.contact.update'),'authority check absent')
check('Telegram uses public v2',consumer.includes('RESOLVE_CONTACT_COMMAND_V2')&&consumer.includes('resolveContactV2({'),'v2 call absent')
check('caller guards preserved',consumer.includes('!contactResult.isNew && username')&&consumer.includes("tgDisplayName.startsWith('@')"),'caller guards drifted')
check('v1 byte identical',sha('gravity-mvp/src/contracts/contacts/v1/resolve-contact-command.ts')==='9d757eb8ea90856fd7beb02012f5f09e034a9fb51edcfb8542caba192701f764','v1 changed')
check('amendment adds v2 only',amend.amendments[0].add_commands.length===1&&amend.amendments[0].add_commands[0]==='ResolveContactCommand.v2','amendment drifted')
process.stdout.write(`${JSON.stringify({status:failures.length?'FAIL':'PASS',checks,failures},null,2)}\n`);if(failures.length)process.exitCode=1
