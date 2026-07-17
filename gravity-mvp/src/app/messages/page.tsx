import ChatsLayout from "./components/ChatsLayout"
import MessagesShell from "./components/MessagesShell"
import { SectionDescription } from "@/components/ui/SectionDescription"
import { ContactService } from "@/lib/ContactService"
import { prisma } from "@/lib/prisma"

export default async function MessagesPage({
    searchParams
}: {
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
    // 1. Read URL Params
    const resolvedParams = await searchParams

    // Normalize id — also resolve driverId/phone to chatId if needed
    let idParam = resolvedParams.id ?? resolvedParams.chatId
    if (!idParam && (typeof resolvedParams.driver === 'string' || typeof resolvedParams.phone === 'string')) {
        try {
            let chat = null
            // Try by driverId first
            if (typeof resolvedParams.driver === 'string') {
                chat = await prisma.chat.findFirst({
                    where: { driverId: resolvedParams.driver },
                    orderBy: { lastMessageAt: 'desc' },
                    select: { id: true },
                })
            }
            // Fallback: search by phone
            if (!chat && typeof resolvedParams.phone === 'string') {
                const phone = resolvedParams.phone.replace(/\D/g, '')
                if (phone.length >= 10) {
                    const last10 = phone.slice(-10)
                    // Search by externalChatId (WhatsApp uses phone as chat ID)
                    chat = await prisma.chat.findFirst({
                        where: { externalChatId: { contains: last10 } },
                        orderBy: { lastMessageAt: 'desc' },
                        select: { id: true },
                    })
                    // Search by driver phone
                    if (!chat) {
                        chat = await prisma.chat.findFirst({
                            where: { driver: { phone: { contains: last10 } } },
                            orderBy: { lastMessageAt: 'desc' },
                            select: { id: true },
                        })
                    }
                    // Search by contact phone
                    if (!chat) {
                        const contact = await prisma.contact.findFirst({
                            where: { phones: { some: { phone: { contains: last10 } } } },
                            select: { id: true },
                        })
                        if (contact) {
                            chat = await prisma.chat.findFirst({
                                where: { contactId: contact.id },
                                orderBy: { lastMessageAt: 'desc' },
                                select: { id: true },
                            })
                        }
                    }
                }
            }
            if (chat) idParam = chat.id

            // If still no chat found and we have a phone, resolve the canonical
            // Contact first. A URL must never create an orphan Chat or trust an
            // arbitrary driver id as automatic identity evidence.
            if (!chat && typeof resolvedParams.phone === 'string') {
                const phone = resolvedParams.phone.replace(/\D/g, '')
                if (phone.length >= 10) {
                    const { normalizePhoneE164 } = await import('@/lib/phoneUtils')
                    const normalized = normalizePhoneE164(resolvedParams.phone) || `+${phone}`
                    const externalId = phone.slice(-10)
                    const contactResult = await ContactService.resolveContact(
                        'whatsapp',
                        externalId,
                        normalized,
                        normalized,
                    )
                    const externalChatId = `whatsapp:${externalId}`
                    const existingChat = await prisma.chat.findUnique({
                        where: { externalChatId },
                        select: { id: true, contactId: true },
                    })
                    if (!existingChat) {
                        const newChat = await prisma.chat.create({
                            data: {
                                channel: 'whatsapp',
                                externalChatId,
                                name: contactResult.contact.displayName,
                                contactId: contactResult.contact.id,
                                contactIdentityId: contactResult.identity.id,
                                status: 'new',
                            },
                            select: { id: true },
                        })
                        idParam = newChat.id
                    } else if (!existingChat.contactId || existingChat.contactId === contactResult.contact.id) {
                        if (!existingChat.contactId) {
                            await prisma.chat.update({
                                where: { id: existingChat.id },
                                data: {
                                    contactId: contactResult.contact.id,
                                    contactIdentityId: contactResult.identity.id,
                                },
                            })
                        }
                        idParam = existingChat.id
                    }
                }
            }
        } catch {}
    }
    const chatId = typeof idParam === 'string' ? idParam : null

    // Normalize list tab (default to 'all')
    const listParam = typeof resolvedParams.list === 'string' ? resolvedParams.list : 'all'
    const allowedListTabs = ['all', 'queue', 'mine', 'waiting', 'resolved', 'unread', 'assigned']
    const activeListTab = allowedListTabs.includes(listParam) ? listParam : 'all'

    // Normalize channel tab (default to 'all')
    const channelParam = typeof resolvedParams.channel === 'string' ? resolvedParams.channel : 'all'
    const allowedChannels = ['all', 'wa', 'tg', 'max', 'av', 'phone', 'gost']
    const activeChannelTab = allowedChannels.includes(channelParam) ? channelParam : 'all'

    // Normalize message deep link
    const initialMessageId = typeof resolvedParams.msg === 'string' ? resolvedParams.msg : null

    // Normalize profile boolean
    const isProfileOpen = resolvedParams.profile === '1'

    return (
        <div className="h-[calc(100vh-theme(spacing.16))] flex flex-col">
            <div className="px-[4px] pt-[4px]">
                <SectionDescription sectionKey="messages" className="mb-[4px]" />
            </div>
            <div className="flex-1 overflow-hidden relative border-t">
                <ChatsLayout>
                    <MessagesShell
                        initialChatId={chatId}
                        activeListTab={activeListTab}
                        activeChannelTab={activeChannelTab}
                        isProfileOpen={isProfileOpen}
                        initialMessageId={initialMessageId}
                    />
                </ChatsLayout>
            </div>
        </div>
    )
}
