#!/usr/bin/env node
import fs from 'node:fs'
const read=file=>fs.readFileSync(file,'utf8'),checks=[],failures=[],check=(name,value,detail)=>value?checks.push(name):failures.push({check:name,detail})
const contract=read('gravity-mvp/src/contracts/contacts/v1/contact-phone-commands.ts'),handler=read('gravity-mvp/src/modules/contacts/public/v1/contact-phone-handler.ts'),adapter=read('gravity-mvp/src/modules/contacts/public/v1/legacy-prisma-contact-phone-adapter.ts'),consumer=read('gravity-mvp/src/app/api/monitoring/sync/route.ts'),fleet=JSON.parse(read('architecture/contexts/v1/manifests/fleet_operations.json')),amendment=JSON.parse(read('architecture/isolation/contacts/fleet-contact-phone-v1/module-manifest-amendments.json'))
check('contract neutral',!/(prisma|next\/|@\/lib|@\/app)/i.test(contract),'contract leak')
check('handler neutral',!/(prisma|next\/|@\/lib|@\/app)/i.test(handler),'handler leak')
check('writes isolated',(adapter.match(/prisma\.contactPhone\.(?:update|create)/g)||[]).length===2&&!/prisma\.contactPhone\.(?:update|create)/.test(consumer),'foreign write remains')
check('owner reads retained',(consumer.match(/prisma\.contactPhone\.findMany/g)||[]).length>=2,'reads drift')
check('deactivate mapping retained',consumer.includes('contactPhoneId: currentYandexPhone.id')&&consumer.indexOf('deactivateContactPhoneV1')<consumer.indexOf('deactivated++'),'deactivate drift')
check('first create mapping retained',consumer.includes('contactId: existing.id')&&consumer.includes('phone: normalizedE164')&&consumer.includes("source: 'yandex'")&&consumer.includes('isPrimary: true'),'first create drift')
check('conditional primary retained',consumer.includes('isPrimary: !existing.primaryPhoneId'),'conditional primary drift')
check('returned ids retained',consumer.includes('contactPhoneId: newPhoneId')&&consumer.includes('updates.primaryPhoneId = newPhoneId'),'returned id drift')
check('unique race catches retained',(consumer.match(/isUniqueConstraintError\(err\)/g)||[]).length===3,'race handling drift')
check('new contact phone mapping retained',consumer.includes('contactId: contact.id')&&consumer.includes('newPhoneId = contactPhoneId')&&consumer.includes('data: { primaryPhoneId: contactPhoneId }'),'new contact drift')
check('adapter exact',adapter.includes('data:{isActive:false}')&&adapter.includes('prisma.contactPhone.create({data:input})'),'adapter drift')
check('commands amendment exact',JSON.stringify(amendment.amendments[0]?.add_commands)===JSON.stringify(['DeactivateContactPhoneCommand.v1','CreateContactPhoneCommand.v1']),'amendment drift')
check('Fleet Contacts dependency pre-approved',fleet.allowed_dependencies.some(item=>item.context==='contacts'&&item.surface==='contacts.public'),'dependency absent')
process.stdout.write(`${JSON.stringify({status:failures.length?'FAIL':'PASS',checks,failures},null,2)}\n`)
if(failures.length)process.exitCode=1
