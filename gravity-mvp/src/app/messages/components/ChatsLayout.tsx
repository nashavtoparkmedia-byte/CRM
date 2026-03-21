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
        <div className="fixed inset-0 z-50 flex h-screen w-screen overflow-hidden bg-white">
            {children}
        </div>
    )
}
