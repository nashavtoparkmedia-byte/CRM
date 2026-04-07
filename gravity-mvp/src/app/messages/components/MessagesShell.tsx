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

import { useState, useTransition } from "react"
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
}: {
    initialChatId: string | null
    activeListTab: string
    activeChannelTab: string
    isProfileOpen: boolean
    initialMessageId: string | null
}) {
    const [chatId, setChatIdState] = useState(initialChatId)
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()
    const [, startTransition] = useTransition()

    const handleSelectChat = (id: string) => {
        setChatIdState(id)
        startTransition(() => {
            const params = new URLSearchParams(searchParams.toString())
            params.set('id', id)
            router.replace(`${pathname}?${params.toString()}`, { scroll: false })
        })
    }

    return (
        <>
            <ChatList
                selectedChatId={chatId}
                activeListTab={activeListTab}
                activeChannelTab={activeChannelTab}
                onSelectChat={handleSelectChat}
            />

            <ChatWorkspace
                chatId={chatId}
                activeChannelTab={activeChannelTab}
                isProfileOpen={isProfileOpen}
                initialMessageId={initialMessageId}
            />

            {isProfileOpen && chatId && (
                <ContactProfileDrawer chatId={chatId} />
            )}
        </>
    )
}
