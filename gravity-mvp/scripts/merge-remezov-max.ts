import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())
import { prisma } from '../src/lib/prisma'
import { ContactMergeService } from '../src/lib/ContactMergeService'

const TARGET_CONTACT = 'cmnjf1ctd06trvp082hhyciz9'  // Ремезов Александр (with phone, TG, WA, driver)
const MAX_EXTERNAL_ID = '27403452'                   // From the screenshot

async function main() {
    // Find the MAX-only Contact (source of merge — will be archived)
    const ident = await prisma.contactIdentity.findUnique({
        where: { channel_externalId: { channel: 'max', externalId: MAX_EXTERNAL_ID } },
        include: { contact: { select: { id: true, displayName: true } } },
    })
    if (!ident) { console.error(`No Contact with MAX:${MAX_EXTERNAL_ID}`); process.exit(1) }
    const sourceId = ident.contact.id
    console.log(`Source: ${sourceId} "${ident.contact.displayName}" (MAX-only)`)
    console.log(`Target: ${TARGET_CONTACT} (Ремезов Александр, main)`)
    if (sourceId === TARGET_CONTACT) {
        console.log('Already same Contact — nothing to merge')
        process.exit(0)
    }

    const result = await ContactMergeService.mergeContactToContact(sourceId, TARGET_CONTACT, 'merge-script')
    console.log('OK:', JSON.stringify(result, null, 2))

    // Verify
    const merged = await prisma.contact.findUnique({
        where: { id: TARGET_CONTACT },
        include: {
            phones: { where: { isActive: true }, select: { phone: true, isPrimary: true } },
            identities: { where: { isActive: true }, select: { channel: true, externalId: true } },
        },
    })
    console.log('\nTarget Contact after merge:')
    console.log(`  phones: ${merged?.phones.map(p => `${p.phone}${p.isPrimary ? '⭐' : ''}`).join(', ')}`)
    console.log(`  identities: ${merged?.identities.map(i => `${i.channel}:${i.externalId}`).join(', ')}`)

    await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
