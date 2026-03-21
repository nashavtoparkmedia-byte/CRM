"use client";

import { Search, Bell } from "lucide-react";
import { usePathname } from "next/navigation";
import { Input } from "./ui/input";

export default function Header() {
    const pathname = usePathname();

    // Simple breadcrumb logic based on pathname
    const getPageTitle = () => {
        switch (pathname) {
            case "/": return "Dashboard";
            case "/drivers": return "Исполнители";
            case "/telegram": return "Telegram Интеграция";
            case "/whatsapp": return "WhatsApp Интеграция";
            case "/settings": return "Настройки";
            case "/map": return "Карта";
            default:
                if (pathname.startsWith("/drivers/")) return "Исполнители / Детали";
                return "Gravity CRM";
        }
    };

    return (
        <header className="sticky top-0 z-50 flex h-16 w-full items-center justify-between border-b bg-card/80 backdrop-blur-md px-6">
            <div className="flex items-center gap-4">
                <h1 className="text-xl font-semibold tracking-tight">
                    {getPageTitle()}
                </h1>
                {/* Placeholder for page-specific actions like the big Yellow '+' */}
            </div>

            <div className="flex items-center gap-4">
                <div className="relative w-64">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        type="search"
                        placeholder="Поиск по системе..."
                        className="h-9 w-full rounded-full bg-secondary pl-9 text-sm focus-visible:ring-1"
                    />
                </div>
                <button className="relative flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground">
                    <Bell className="h-5 w-5" />
                    <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-destructive" />
                </button>
            </div>
        </header>
    );
}
