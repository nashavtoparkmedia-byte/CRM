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
}) {
    const [chatId, setChatIdState] = useState(initialChatId)
    const [channelTab, setChannelTab] = useState(activeChannelTab)
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()
    const [, startTransition] = useTransition()

    // Sync channelTab with URL param (ChatChannelTabs updates URL directly)
    const urlChannel = searchParams.get('channel') || 'all'
    const profileContactId = searchParams.get('contact') || null
    useEffect(() => {
        setChannelTab(urlChannel)
    }, [urlChannel])

    // Sync chatId from URL — handles external router.push (e.g., forwarded-from click)
    const urlChatId = searchParams.get('id') || null
    useEffect(() => {
        if (urlChatId) {
            setChatIdState((currentChatId) => currentChatId === urlChatId ? currentChatId : urlChatId)
        }
    }, [urlChatId])

    const handleSelectChat = (id: string, channelHint?: string) => {
        setChatIdState(id)
        if (channelHint) {
            setChannelTab(channelHint)
        }
        startTransition(() => {
            const params = new URLSearchParams(searchParams.toString())
            params.set('id', id)
            params.delete('contact')
            if (channelHint) {
                params.set('channel', channelHint)
            }
            router.replace(`${pathname}?${params.toString()}`, { scroll: false })
        })
    }

    // Mobile "back": deselect the chat so the list takes over the screen again.
    // On desktop the back arrow is hidden, so this only fires on small screens.
    const handleBack = () => {
        setChatIdState(null)
        startTransition(() => {
            const params = new URLSearchParams(searchParams.toString())
            params.delete('id')
            params.delete('contact')
            const qs = params.toString()
            router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
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
                onBack={handleBack}
            />

            {isProfileOpen && chatId && (
                <ContactProfileDrawer chatId={chatId} contactId={profileContactId} />
            )}
        </>
    )
}
