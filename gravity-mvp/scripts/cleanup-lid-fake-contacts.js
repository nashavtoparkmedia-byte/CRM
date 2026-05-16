/**
 * Roll back fake "phone" contacts created from un-translated LID JIDs.
 *
 * When the WhatsApp ingestion saw a `<lid>@lid` JID and getContact() didn't
 * return a real number, the OLD code blindly took the LID's tail-10 digits
 * and prepended '7' to make a Russian-looking phone, then:
 *   - keyed the Chat with externalChatId = `whatsapp:7XXXXXXXXXX`
 *   - created a ContactPhone +7XXXXXXXXXX
 *   - created a ContactIdentity (whatsapp, "7XXXXXXXXXX")
 *   - created a Contact with displayName "+7XXXXXXXXXX"
 *
 * All four bind a totally unrelated phone number to a real person. The
 * user noticed: "this LID-derived '+73509372005' is probably actually the
 * +7 920 048-63-60 person — but I have no way to know that from the UI."
 *
 * This script reverts those rows:
 *   - Chat.externalChatId → `<lid>@lid`
 *   - Chat.name           → "WhatsApp @lid:<tail-8>"
 *   - Contact.displayName → "WhatsApp @lid:<tail-8>" (only if it matches
 *                          the fake "+7XXX" pattern; otherwise keep user-set)
 *   - ContactPhone  +7XXX → isActive=false, isPrimary=false
 *   - ContactIdentity (whatsapp, "7XXX") → externalId set to the LID,
 *                          phoneId nulled
 *
 * Idempotent. Safe to re-run.
 */
const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    // Same heuristic as find-lid-fake-contacts.js
    const msgs = await prisma.message.findMany({
        where: { channel: 'whatsapp', externalId: { contains: '@lid_' } },
        select: { chatId: true, externalId: true },
    })
    const chatIds = [...new Set(msgs.map(m => m.chatId))]
    console.log(`Scanning ${chatIds.length} chats with @lid messages...\n`)

    let processed = 0
    for (const chatId of chatIds) {
        const chat = await prisma.chat.findUnique({
            where: { id: chatId },
            include: { contact: { include: { phones: true, identities: true } } },
        })
        if (!chat) continue
        // Skip if already in LID format
        if (chat.externalChatId?.includes('@lid')) continue
        const sample = msgs.find(m => m.chatId === chatId)
        const lidMatch = sample?.externalId?.match(/_(\d+)@lid_/)
        const lid = lidMatch?.[1]
        if (!lid || lid.length < 10) continue
        const fakePhoneDigits = '7' + lid.slice(-10)
        if (chat.externalChatId !== `whatsapp:${fakePhoneDigits}`) continue

        const fakeE164 = `+${fakePhoneDigits}`
        const lidLabel = `WhatsApp @lid:${lid.slice(-8)}`

        console.log(`Cleaning chat ${chat.id}:`)
        console.log(`  externalChatId: ${chat.externalChatId} → ${lid}@lid`)
        console.log(`  contact: ${chat.contact?.displayName} (${chat.contactId})`)

        // 1. Rewrite Chat — but if a chat with the LID externalChatId already
        //    exists (the original LID-keyed sync row), merge this fake chat
        //    INTO it instead of renaming (renaming would hit a unique constraint).
        const existingLidChat = await prisma.chat.findUnique({
            where: { externalChatId: `${lid}@lid` },
        })
        if (existingLidChat && existingLidChat.id !== chat.id) {
            console.log(`  merging into existing LID chat ${existingLidChat.id}`)
            // Move messages from fake chat into the real LID chat, dropping
            // exact-externalId duplicates.
            const fakeMsgs = await prisma.message.findMany({
                where: { chatId: chat.id },
                select: { id: true, externalId: true },
            })
            let moved = 0
            for (const m of fakeMsgs) {
                if (m.externalId) {
                    const dup = await prisma.message.findFirst({
                        where: { chatId: existingLidChat.id, externalId: m.externalId },
                        select: { id: true },
                    })
                    if (dup) {
                        await prisma.message.delete({ where: { id: m.id } })
                        continue
                    }
                }
                await prisma.message.update({ where: { id: m.id }, data: { chatId: existingLidChat.id } })
                moved++
            }
            console.log(`  moved ${moved} messages`)
            // Detach the fake chat's identity link, then delete the chat.
            await prisma.chat.update({ where: { id: chat.id }, data: { contactIdentityId: null } })
            await prisma.chat.delete({ where: { id: chat.id } })
        } else {
            await prisma.chat.update({
                where: { id: chat.id },
                data: {
                    externalChatId: `${lid}@lid`,
                    // Only set name if it's empty — preserve user-set names
                    name: chat.name ?? lidLabel,
                },
            })
        }

        if (chat.contact) {
            // 2. Rename contact only if displayName matches the fake "+7XXX" pattern.
            //    If the operator has renamed it (e.g. via merge), leave alone.
            if (chat.contact.displayName === fakeE164) {
                await prisma.contact.update({
                    where: { id: chat.contact.id },
                    data: { displayName: lidLabel },
                })
                console.log(`  contact displayName: ${fakeE164} → ${lidLabel}`)
            }

            // 3. Deactivate fake ContactPhone
            const fakePhoneRow = chat.contact.phones.find(p => p.phone === fakeE164)
            if (fakePhoneRow) {
                await prisma.contactPhone.update({
                    where: { id: fakePhoneRow.id },
                    data: { isActive: false, isPrimary: false },
                })
                console.log(`  contactPhone ${fakeE164}: deactivated`)
            }

            // 4. Update ContactIdentity:
            //    a) if there's an identity (whatsapp, fakePhoneDigits), rewrite it
            //       to (whatsapp, LID) when no such identity exists anywhere
            //    b) otherwise deactivate the fake one (another row already owns
            //       (whatsapp, LID), possibly on a different Contact)
            const fakeIdentity = chat.contact.identities.find(i => i.channel === 'whatsapp' && i.externalId === fakePhoneDigits)
            if (fakeIdentity) {
                const existingLidIdent = await prisma.contactIdentity.findFirst({
                    where: { channel: 'whatsapp', externalId: lid },
                })
                if (!existingLidIdent) {
                    await prisma.contactIdentity.update({
                        where: { id: fakeIdentity.id },
                        data: { externalId: lid, phoneId: null },
                    })
                    console.log(`  contactIdentity whatsapp:${fakePhoneDigits} → whatsapp:${lid}`)
                } else {
                    await prisma.contactIdentity.update({
                        where: { id: fakeIdentity.id },
                        data: { isActive: false, phoneId: null },
                    })
                    console.log(`  contactIdentity whatsapp:${fakePhoneDigits}: deactivated (real LID identity already exists)`)
                }
            }
        }

        processed++
        console.log()
    }

    console.log(`\nProcessed ${processed} fake-LID chats.`)
    await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
