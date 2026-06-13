"use client"

import { ReactNode, useEffect } from "react"

export default function ChatsLayout({ children }: { children: ReactNode }) {
    useEffect(() => {
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = '';
            document.documentElement.style.overflow = '';
        };
    }, []);

    return (
        // Full viewport, no CRM chrome. Pure messenger.
        // h-[100dvh] (not h-screen/100vh): on mobile the browser toolbar eats
        // the bottom of 100vh, hiding the message input below the fold. dvh =
        // dynamic viewport height tracks the visible area. On desktop dvh==vh.
        <div className="fixed inset-0 z-50 flex h-[100dvh] w-screen overflow-hidden bg-white">
            {children}
        </div>
    )
}
