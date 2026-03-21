"use client"

import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { useCallback } from "react"

export function useChatNavigation() {
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()

    // Base utility to update search params shallowly
    const updateQuery = useCallback((updates: Record<string, string | null>) => {
        const current = new URLSearchParams(Array.from(searchParams.entries()))
        
        Object.entries(updates).forEach(([key, value]) => {
            if (value === null) {
                current.delete(key)
            } else {
                current.set(key, value)
            }
        })

        const search = current.toString()
        const query = search ? `?${search}` : ""
        
        // Shallow routing in Next.js App Router: router.push or router.replace without re-fetching
        // Since Next.js 13/14, router.push with same pathname and new query is shallow by default 
        // if the page doesn't depend on dynamic data that changed.
        router.push(`${pathname}${query}`, { scroll: false })
    }, [pathname, router, searchParams])

    const setChatId = useCallback((id: string | null) => {
        // Changing chat does not reset the channel
        updateQuery({ id })
    }, [updateQuery])

    const setListTab = useCallback((listTab: 'all' | 'unread' | 'assigned' | 'auto' | 'ai') => {
        updateQuery({ list: listTab === 'all' ? null : listTab })
    }, [updateQuery])

    const setChannel = useCallback((channel: 'all' | 'wa' | 'tg' | 'max' | 'ypro' | 'gost') => {
        updateQuery({ channel: channel === 'all' ? null : channel })
    }, [updateQuery])

    const toggleProfileDrawer = useCallback((isOpen: boolean) => {
        updateQuery({ profile: isOpen ? "1" : null })
    }, [updateQuery])

    return {
        setChatId,
        setListTab,
        setChannel,
        toggleProfileDrawer,
        updateQuery
    }
}
