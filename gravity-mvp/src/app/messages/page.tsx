import ChatsLayout from "./components/ChatsLayout"
import MessagesShell from "./components/MessagesShell"
import { SectionDescription } from "@/components/ui/SectionDescription"
import { normalizePhoneE164 } from "@/lib/phoneUtils"
import { prisma } from "@/lib/prisma"
import { resolveStrictPhoneOwnership } from "@/lib/contacts/strict-phone-ownership"

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
            if (typeof resolvedParams.driver === 'string') {
                const driver = await prisma.driver.findUnique({
                    where: { id: resolvedParams.driver },
                    select: { id: true, contactId: true },
                })
                if (driver) {
                    chat = await prisma.chat.findFirst({
                        where: driver.contactId
                            ? { contactId: driver.contactId }
                            : { driverId: driver.id },
                        orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
                        select: { id: true },
                    })
                }
            }

            if (!chat && typeof resolvedParams.phone === 'string') {
                const normalized = normalizePhoneE164(resolvedParams.phone)
                if (normalized) {
                    const ownership = await resolveStrictPhoneOwnership(prisma, normalized)
                    if (ownership.kind === 'matched') {
                        chat = await prisma.chat.findFirst({
                            where: { contactId: ownership.contactId },
                            orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
                            select: { id: true },
                        })
                    }
                }
            }
            if (chat) idParam = chat.id
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
