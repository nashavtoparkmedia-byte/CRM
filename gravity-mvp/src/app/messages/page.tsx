import { Metadata } from "next"
import ChatsLayout from "./components/ChatsLayout"
import MessagesShell from "./components/MessagesShell"
import { SectionDescription } from "@/infrastructure/ui/SectionDescription"

export default async function MessagesPage({
    searchParams
}: {
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
    // 1. Read URL Params
    const resolvedParams = await searchParams

    // Only an explicit, already-admitted Chat identifier may select a
    // conversation. Driver/phone query strings are display navigation hints,
    // not identity evidence and never create or guess a Chat during render.
    const idParam = resolvedParams.id ?? resolvedParams.chatId
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
