import type { Metadata } from "next";

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
    return (
        <div className="fixed inset-0 z-50 bg-white">
            {children}
        </div>
    );
}
