"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import React, { useEffect, useState } from "react";
import { 
    Users, Car, Map, Settings, MessageSquare, Phone, Activity, 
    Bot, BarChart3, Inbox, Archive, UserPlus, Gift, Target, 
    PieChart, ChevronLeft, ChevronRight, ChevronDown
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const navigationGroups = [
    {
        title: "Главная",
        items: [
            { name: "Dashboard", href: "/", icon: Activity },
            { name: "Карта", href: "/map", icon: Map },
        ]
    },
    {
        title: "Исполнители",
        items: [
            { name: "Водители", href: "/drivers", icon: Users },
            { name: "Карточки", href: "/drivers/cards", icon: Car },
            { name: "Мониторинг", href: "/monitoring", icon: BarChart3 },
            { name: "Архив", href: "/drivers/archive", icon: Archive },
        ]
    },
    {
        title: "Развитие",
        items: [
            { name: "Лиды", href: "/leads", icon: UserPlus },
            { name: "Акции", href: "/promotions", icon: Gift },
        ]
    },
    {
        title: "Коммуникации",
        items: [
            { name: "Мессенджер", href: "/messages", icon: MessageSquare },
            { 
                name: "Настройки", 
                icon: Settings, 
                subItems: [
                    { name: "Telegram", href: "/telegram", icon: MessageSquare },
                    { name: "MAX", href: "/max", icon: MessageSquare },
                    { name: "TG Бот", href: "/bot-admin", icon: Bot },
                    { name: "WhatsApp", href: "/whatsapp", icon: Phone },
                ]
            },
            { name: "Задачи", href: "/inbox", icon: Inbox },
        ]
    },
    {
        title: "Аналитика",
        items: [
            { name: "LTV водителей", href: "/analytics", icon: PieChart },
        ]
    }
];

export function Sidebar() {
    const pathname = usePathname();
    const [isCollapsed, setIsCollapsed] = useState(false);
    const [isMounted, setIsMounted] = useState(false);
    const [expandedMenus, setExpandedMenus] = useState<Record<string, boolean>>({});

    useEffect(() => {
        setIsMounted(true);
        const saved = localStorage.getItem("sidebarCollapsed");
        if (saved !== null) {
            setIsCollapsed(JSON.parse(saved));
        }
    }, []);

    const toggleSidebar = () => {
        const newState = !isCollapsed;
        setIsCollapsed(newState);
        localStorage.setItem("sidebarCollapsed", JSON.stringify(newState));
    };

    const toggleSubMenu = (name: string) => {
        setExpandedMenus(prev => ({ ...prev, [name]: !prev[name] }));
    };

    const renderLink = (item: any, isCollapsedMode: boolean, isNested: boolean = false) => {
        const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));

        const linkContent = (
            <Link
                href={item.href}
                className={cn(
                    "group flex items-center transition-all",
                    isCollapsedMode 
                        ? "justify-center mx-3 h-11 w-11 rounded-xl hover:bg-secondary" 
                        : cn(
                            "h-11 hover:bg-muted/50 border-l-2",
                            isNested ? "pl-14 pr-6 text-sm h-10 border-transparent" : "pl-6 pr-6 h-11"
                          ),
                    isActive 
                        ? isCollapsedMode
                            ? "bg-secondary text-primary"
                            : isNested ? "text-primary font-semibold" : "bg-muted border-primary text-primary"
                        : isCollapsedMode
                            ? "text-muted-foreground"
                            : "border-transparent text-muted-foreground"
                )}
            >
                <item.icon className={cn(isNested && !isCollapsedMode ? "h-4 w-4" : "h-5 w-5", "flex-shrink-0", isActive ? "text-primary" : "")} />
                {!isCollapsedMode && (
                    <span className="ml-3 font-medium">{item.name}</span>
                )}
            </Link>
        );

        if (isCollapsedMode) {
            return (
                <Tooltip key={item.name}>
                    <TooltipTrigger asChild>
                        {linkContent}
                    </TooltipTrigger>
                    <TooltipContent side="right" className="ml-2">
                        {item.name}
                    </TooltipContent>
                </Tooltip>
            );
        }

        return linkContent;
    };

    if (!isMounted) return null;

    return (
        <TooltipProvider delayDuration={0}>
            <div className={cn(
                "flex flex-col justify-between border-r bg-card transition-all duration-300 relative",
                isCollapsed ? "w-20" : "w-64"
            )}>
                {/* Toggle Button */}
                <button
                    onClick={toggleSidebar}
                    className="absolute -right-3 top-6 flex h-6 w-6 items-center justify-center rounded-full border bg-background shadow-sm hover:bg-secondary z-50"
                >
                    {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                </button>

                <div className="flex flex-col h-full overflow-y-auto pt-6 pb-6 no-scrollbar">
                    {/* Logo Section */}
                    <div className={cn(
                        "flex items-center px-6 mb-8",
                        isCollapsed ? "justify-center px-0" : ""
                    )}>
                        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-black shadow-sm">
                            <div className="h-4 w-4 rounded-sm bg-primary" />
                        </div>
                        {!isCollapsed && <span className="ml-3 font-semibold text-lg tracking-tight">Gravity</span>}
                    </div>

                    {/* Navigation Groups */}
                    <nav className="flex-1 space-y-6">
                        {navigationGroups.map((group, groupIndex) => (
                            <div key={groupIndex} className="flex flex-col">
                                {!isCollapsed && (
                                    <h3 className="mb-2 px-6 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                                        {group.title}
                                    </h3>
                                )}

                                <div className="space-y-1">
                                    {group.items.map((item) => {
                                        if (item.subItems) {
                                            if (isCollapsed) {
                                                return (
                                                    <React.Fragment key={item.name}>
                                                        {item.subItems.map((subItem: any) => (
                                                            <div key={subItem.name}>{renderLink(subItem, true)}</div>
                                                        ))}
                                                    </React.Fragment>
                                                );
                                            }

                                            const isSubMenuActive = item.subItems.some((sub: any) => pathname === sub.href || pathname.startsWith(sub.href));
                                            const isMenuExpanded = expandedMenus[item.name];

                                            const menuButton = (
                                                <button
                                                    onClick={() => toggleSubMenu(item.name)}
                                                    className={cn(
                                                        "group flex w-full items-center h-11 px-6 border-l-2 border-transparent hover:bg-muted/50 transition-all",
                                                        isSubMenuActive ? "text-primary" : "text-muted-foreground"
                                                    )}
                                                >
                                                    <item.icon className={cn("h-5 w-5 flex-shrink-0", isSubMenuActive ? "text-primary" : "")} />
                                                    <span className="ml-3 text-sm font-medium flex-1 text-left">{item.name}</span>
                                                    {isMenuExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                                </button>
                                            );

                                            return (
                                                <div key={item.name} className="flex flex-col">
                                                    {menuButton}
                                                    {isMenuExpanded && (
                                                        <div className="mt-1 flex flex-col space-y-1">
                                                            {item.subItems.map((subItem: any) => (
                                                                <div key={subItem.name}>{renderLink(subItem, false, true)}</div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        }

                                        return <div key={item.name}>{renderLink(item, isCollapsed)}</div>;
                                    })}
                                </div>
                            </div>
                        ))}
                    </nav>
                </div>

                {/* Footer / User Profile */}
                <div className="border-t p-4 flex flex-col items-center">
                    <button className={cn(
                        "flex items-center w-full rounded-xl hover:bg-secondary/80 transition-colors p-2",
                        isCollapsed ? "justify-center" : "px-3"
                    )}>
                        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                            <span className="text-sm font-medium">Ю</span>
                        </div>
                        {!isCollapsed && (
                            <div className="ml-3 flex flex-col items-start overflow-hidden">
                                <span className="text-sm font-medium leading-none">Юзер</span>
                                <span className="text-xs text-muted-foreground mt-1 truncate max-w-full">Менеджер парка</span>
                            </div>
                        )}
                    </button>
                    {!isCollapsed && (
                        <Link href="/settings" className="flex items-center w-full p-3 mt-2 rounded-xl text-muted-foreground hover:bg-secondary/80 hover:text-foreground transition-colors text-sm font-medium">
                            <Settings className="h-5 w-5 mr-3" />
                            Настройки
                        </Link>
                    )}
                    {isCollapsed && (
                         <div className="mt-4">
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Link href="/settings" className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground hover:bg-secondary/80 hover:text-foreground transition-colors">
                                        <Settings className="h-5 w-5" />
                                    </Link>
                                </TooltipTrigger>
                                <TooltipContent side="right" className="ml-2">
                                    Настройки
                                </TooltipContent>
                            </Tooltip>
                        </div>
                    )}
                </div>
            </div>
        </TooltipProvider>
    );
}
