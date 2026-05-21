import type { Metadata } from "next";
import { Suspense } from "react";
import CallDetailDrawer from "./components/CallDetailDrawer";

export const metadata: Metadata = {
    title: "Мессенджер | Yoko",
    description: "Нативный агрегатор сообщений для операторов",
};

export default function MessagesLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    // This layout COMPLETELY replaces the global CRM shell (Sidebar + Header).
    // The messenger owns the full viewport. No CRM chrome visible by default.
    //
    // CallDetailDrawer sits at the root so it can overlay any inner page
    // (chat list, conversation, profile drawer). It reads `?call=<id>` from
    // the URL and hides itself when the param is absent — no prop drilling.
    //
    // Wrapped in <Suspense> because the drawer uses useSearchParams() which
    // in Next.js 16 throws a suspense promise. Without a boundary that
    // throw bubbles up and unmounts the whole messenger view — leaving the
    // operator with an empty "Нет сообщений" screen.
    return (
        <div className="fixed inset-0 z-50 bg-white">
            {children}
            <Suspense fallback={null}>
                <CallDetailDrawer />
            </Suspense>
        </div>
    );
}
