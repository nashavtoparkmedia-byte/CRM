import { Metadata } from "next"
import ChatsLayout from "./components/ChatsLayout"
import ChatList from "./components/ChatList"
import ChatWorkspace from "./components/ChatWorkspace"
import ContactProfileDrawer from "./components/ContactProfileDrawer"

export default async function MessagesPage({
    searchParams
}: {
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
    // 1. Read URL Params
    const resolvedParams = await searchParams
    
    // Normalize id
    const idParam = resolvedParams.id
    const chatId = typeof idParam === 'string' ? idParam : null

    // Normalize list tab (default to 'all')
    const listParam = typeof resolvedParams.list === 'string' ? resolvedParams.list : 'all'
    const allowedListTabs = ['all', 'unread', 'assigned', 'auto', 'ai'] 
    const activeListTab = allowedListTabs.includes(listParam) ? listParam : 'all'

    // Normalize channel tab (default to 'all')
    const channelParam = typeof resolvedParams.channel === 'string' ? resolvedParams.channel : 'all'
    const allowedChannels = ['all', 'wa', 'tg', 'max', 'ypro', 'gost']
    const activeChannelTab = allowedChannels.includes(channelParam) ? channelParam : 'all'

    // Normalize profile boolean 
    const isProfileOpen = resolvedParams.profile === '1'

    return (
        <ChatsLayout>
            {/* NO MiniSidebar. CRM is accessed via the floating trigger inside ChatList header. */}

            {/* 1. Chat List (320px) */}
            <ChatList 
                selectedChatId={chatId} 
                activeListTab={activeListTab}
                activeChannelTab={activeChannelTab}
            />

            {/* 2. Chat Workspace (1fr, Core Messaging Area) */}
            <ChatWorkspace 
                chatId={chatId} 
                activeChannelTab={activeChannelTab} 
                isProfileOpen={isProfileOpen}
            />

            {/* 3. Contact Profile Drawer (Right-most, 320px, conditionally rendered) */}
            {isProfileOpen && chatId && (
                <ContactProfileDrawer chatId={chatId} />
            )}
        </ChatsLayout>
    )
}
