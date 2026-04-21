"use client"

/**
 * MessagesShell — client-side chatId state manager.
 *
 * WHY THIS EXISTS:
 *   page.tsx is an async server component that reads chatId from URL searchParams.
 *   Every router.push() with a new ?id= causes Next.js to re-run the server component
 *   (full RSC round-trip ~1s). This makes chat switching feel sluggish.
 *
 *   Fix: manage chatId as client-side useState here. On click:
 *     1. setChatIdState(id) — instant UI update, no server round-trip
 *     2. router.replace (inside startTransition) — syncs URL for bookmarks/reload
 *
 *   page.tsx passes the initial chatId from the URL; subsequent switches are local.
 */

import { useState, useTransition, useEffect } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import ChatList from "./ChatList"
import ChatWorkspace from "./ChatWorkspace"
import ContactProfileDrawer from "./ContactProfileDrawer"

export default function MessagesShell({
    initialChatId,
    activeListTab,
    activeChannelTab,
    isProfileOpen,
    initialMessageId,
    initialPhone,
}: {
    initialChatId: string | null
    activeListTab: string
    activeChannelTab: string
    isProfileOpen: boolean
    initialMessageId: string | null
    initialPhone?: string | null
    initialPhone?: string | null
}) {
    const [chatId, setChatIdState] = useState(initialChatId)
    const [channelTab, setChannelTab] = useState(activeChannelTab)
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()
    const [, startTransition] = useTransition()

    // Sync channelTab with URL param (ChatChannelTabs updates URL directly)
    const urlChannel = searchParams.get('channel') || 'all'
    useEffect(() => {
        setChannelTab(urlChannel)
    }, [urlChannel])

    const handleSelectChat = (id: string, channelHint?: string) => {
        setChatIdState(id)
        if (channelHint) {
            setChannelTab(channelHint)
        }
        startTransition(() => {
            const params = new URLSearchParams(searchParams.toString())
            params.set('id', id)
            if (channelHint) {
                params.set('channel', channelHint)
            }
            router.replace(`${pathname}?${params.toString()}`, { scroll: false })
        })
    }

    return (
        <>
            <ChatList
                selectedChatId={chatId}
                activeListTab={activeListTab}
                activeChannelTab={channelTab}
                onSelectChat={handleSelectChat}
                initialPhone={initialPhone}
            />

            <ChatWorkspace
                chatId={chatId}
                activeChannelTab={channelTab}
                isProfileOpen={isProfileOpen}
                initialMessageId={initialMessageId}
            />

            {isProfileOpen && chatId && (
                <ContactProfileDrawer chatId={chatId} />
            )}
        </>
    )
}
