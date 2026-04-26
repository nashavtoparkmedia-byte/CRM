import { Metadata } from "next"
import ChatsLayout from "./components/ChatsLayout"
import MessagesShell from "./components/MessagesShell"
import { SectionDescription } from "@/components/ui/SectionDescription"
import { prisma } from "@/lib/prisma"

export default async function MessagesPage({
    searchParams
}: {
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
    // 1. Read URL Params
    const resolvedParams = await searchParams

    // Normalize id — also resolve driverId/phone to chatId if needed
    let idParam = resolvedParams.id
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

            // If still no chat found and we have a phone — create one server-side
            if (!chat && typeof resolvedParams.phone === 'string') {
                const phone = resolvedParams.phone.replace(/\D/g, '')
                if (phone.length >= 10) {
                    const { normalizePhoneE164 } = await import('@/lib/phoneUtils')
                    const normalized = normalizePhoneE164(resolvedParams.phone) || `+${phone}`
                    const newChat = await prisma.chat.create({
                        data: {
                            channel: 'whatsapp',
                            externalChatId: `whatsapp:${phone}@s.whatsapp.net`,
                            name: normalized,
                            driverId: typeof resolvedParams.driver === 'string' ? resolvedParams.driver : undefined,
                            status: 'new',
                        },
                        select: { id: true },
                    })
                    idParam = newChat.id
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
    const allowedChannels = ['all', 'wa', 'tg', 'max', 'av', 'ypro', 'phone', 'gost']
    const activeChannelTab = allowedChannels.includes(channelParam) ? channelParam : 'all'

    // Normalize message deep link
    const initialMessageId = typeof resolvedParams.msg === 'string' ? resolvedParams.msg : null

    // Normalize profile boolean
    const isProfileOpen = resolvedParams.profile === '1'

    return (
        <div className="h-[calc(100vh-theme(spacing.16))] flex flex-col">
            <div className="px-4 pt-4">
                <SectionDescription sectionKey="messages" className="mb-4" />
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
