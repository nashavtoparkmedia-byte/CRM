"use client";

import React, { useState, useEffect } from "react";
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from "@/lib/utils";
import { DOMAINS, NavigationDomain } from "@/config/navigation-domains";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function Sidebar() {
    const pathname = usePathname();
    const router = useRouter();
    const [mounted, setMounted] = useState(false);
    
    // Auto-collapse logic & hover
    const [isOpen, setIsOpen] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [hoveredDomainKey, setHoveredDomainKey] = useState<string | null>(null);
    
    // Track last visited section per domain
    const [lastVisited, setLastVisited] = useState<Record<string, string>>({});

    const getCurrentDomain = () => {
        for (const domain of DOMAINS) {
            const itemMatch = domain.items?.some(item => pathname === item.href || (item.href !== '/' && !!item.href && pathname.startsWith(item.href)));
            const groupMatch = domain.groups?.some(group => group.items.some(item => pathname === item.href || (item.href !== '/' && !!item.href && pathname.startsWith(item.href))));
            if (itemMatch || groupMatch) {
                return domain;
            }
        }
        return DOMAINS[0];
    };

    const initialDomain = getCurrentDomain();
    const [activeDomainKey, setActiveDomainKey] = useState<string>(initialDomain.key);
    
    const [isMobile, setIsMobile] = useState(false);

    useEffect(() => {
        setMounted(true);
        const handleResize = () => setIsMobile(window.innerWidth < 1200);
        handleResize();
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Deep link behavior: update active domain
    useEffect(() => {
        if (mounted) {
            const domain = getCurrentDomain();
            setActiveDomainKey(domain.key);
            setLastVisited(prev => ({
                ...prev,
                [domain.key]: pathname
            }));
            
            // Save global CRM route so Messenger can return here
            if (!pathname.startsWith('/messages')) {
                localStorage.setItem('last_crm_route', pathname);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pathname, mounted]);

    const activeDomain = DOMAINS.find(d => d.key === activeDomainKey) || DOMAINS[0];
    const displayDomainKey = hoveredDomainKey || activeDomainKey;
    const displayDomain = DOMAINS.find(d => d.key === displayDomainKey) || DOMAINS[0];

    const handleDomainClick = (e: React.MouseEvent, domain: NavigationDomain) => {
        e.preventDefault();
        setActiveDomainKey(domain.key);
        setIsOpen(true); // Open panel on click
        
        const firstItemHref = domain.items?.[0]?.href || domain.groups?.[0]?.items?.[0]?.href;
        const targetPath = lastVisited[domain.key] || firstItemHref;
        if (targetPath && targetPath !== pathname) {
            router.push(targetPath);
        }
    };

    const handleLinkClick = () => {
        // Auto-collapse after clicking a section link
        setIsOpen(false);
        setIsHovered(false);
        setHoveredDomainKey(null);
    };

    if (!mounted) return <div className="w-[72px] h-screen border-r border-[#e5e7eb] bg-white flex-shrink-0" />; 

    const showContextPanel = !displayDomain.hideContextPanel && (isOpen || isHovered);
    const contextPanelWidth = showContextPanel ? 280 : 0;
    
    // On mobile, the sidebar footprint is always 72px (panel is strict overlay)
    // On desktop, the sidebar footprint expands to push content
    const sidebarWidth = isMobile ? 72 : 72 + contextPanelWidth;

    return (
        <TooltipProvider delayDuration={300}>
            {/* Mobile / Overlay background */}
            {isMobile && showContextPanel && (
                <div 
                    className="fixed inset-0 bg-black/20 z-40 transition-opacity" 
                    onClick={() => setIsOpen(false)}
                />
            )}

            <div 
                className={cn(
                    "fixed left-0 top-0 flex flex-shrink-0 h-[100vh] transition-all duration-300 z-50 bg-background",
                )}
                style={{ width: sidebarWidth }}
                onMouseEnter={() => !isMobile && setIsHovered(true)}
                onMouseLeave={() => {
                    if (!isMobile) {
                        setIsHovered(false);
                        setHoveredDomainKey(null);
                    }
                }}
            >
                {/* 1. ICON RAIL (Fixed 72px) */}
                <aside className="w-[72px] h-full bg-[#ffffff] border-r border-[#e5e7eb] flex flex-col items-center py-4 flex-shrink-0 z-50">
                    <div className="mb-6 flex h-[40px] w-[40px] flex-shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground cursor-pointer shadow-sm">
                        <span className="font-bold text-lg">Y</span>
                    </div>

                    <nav className="flex flex-col gap-2 flex-1 w-full items-center">
                        {DOMAINS.map(domain => {
                            const isActive = activeDomainKey === domain.key;
                            const firstItemHref = domain.items?.[0]?.href || domain.groups?.[0]?.items?.[0]?.href;
                            const targetPath = lastVisited[domain.key] || firstItemHref || '#';
                            
                            const railItem = (
                                <div className="w-full flex justify-center px-3" key={domain.key}>
                                    <a
                                        href={targetPath}
                                        onMouseEnter={() => !isMobile && setHoveredDomainKey(domain.key)}
                                        onClick={(e) => handleDomainClick(e, domain)}
                                        className={cn(
                                            "w-[40px] h-[40px] flex items-center justify-center rounded-[12px] transition-colors focus:outline-none",
                                            isActive 
                                                ? "bg-[#eef2ff] text-[#4f46e5]" 
                                                : "text-[#6b7280] hover:bg-[#f3f4f6]"
                                        )}
                                    >
                                        <domain.icon className="w-[22px] h-[22px]" strokeWidth={2} />
                                    </a>
                                </div>
                            );

                            return railItem;
                        })}
                    </nav>

                    <div className="mt-auto px-3">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button className="w-[40px] h-[40px] flex items-center justify-center rounded-[12px] text-[#6b7280] hover:bg-[#f3f4f6] transition-colors focus:outline-none">
                                    <div className="flex h-[32px] w-[32px] items-center justify-center rounded-full bg-black text-xs font-medium text-white">
                                        Ю
                                    </div>
                                </button>
                            </TooltipTrigger>
                            <TooltipContent side="right" sideOffset={18}>Профиль Юзера</TooltipContent>
                        </Tooltip>
                    </div>
                </aside>

                {/* 2. CONTEXT PANEL (280px, context-dependent) */}
                <aside 
                    className={cn(
                        "h-full bg-white border-r border-[#e5e7eb] flex flex-col transition-transform duration-300 w-[280px] absolute left-[72px] top-0",
                        !isMobile ? "static border-l-0 shadow-none z-0" : "fixed shadow-xl z-50 border-l",
                        showContextPanel ? "translate-x-0 opacity-100" : "-translate-x-full opacity-0 pointer-events-none"
                    )}
                >
                    <div className="px-5 pt-6 pb-4 flex-shrink-0">
                        <h2 className="text-[18px] font-semibold text-gray-900">{displayDomain.label}</h2>
                    </div>
                    
                    <div className="flex-1 overflow-y-auto px-3 pb-6 space-y-0.5">
                        {/* Основные пункты (если есть) */}
                        {displayDomain.items?.map((item, i) => {
                            const isItemActive = pathname === item.href || (item.href !== '/' && !!item.href && pathname.startsWith(item.href));
                            return (
                                <Link
                                    key={item.href || i}
                                    href={item.href}
                                    onClick={handleLinkClick}
                                    className={cn(
                                        "group relative flex items-center w-full h-[40px] px-3 rounded-md transition-colors text-sm",
                                        isItemActive 
                                            ? "bg-[#eef2ff] text-[#4f46e5] font-medium" 
                                            : "text-gray-700 hover:bg-[#f9fafb]"
                                    )}
                                >
                                    <div className={cn(
                                        "absolute left-0 w-[3px] h-[20px] rounded-r-full transition-colors",
                                        isItemActive ? "bg-[#4f46e5]" : "bg-transparent"
                                    )} />
                                    <item.icon className={cn("w-[20px] h-[20px] mr-3 z-10", isItemActive ? "text-[#4f46e5]" : "text-[#6b7280] group-hover:text-gray-900")} />
                                    <span className="z-10">{item.label}</span>
                                </Link>
                            )
                        })}

                        {/* Группы (Интеграции и др.) */}
                        {displayDomain.groups?.map((group, gIdx) => (
                            <div key={gIdx} className={cn("mt-4", gIdx === 0 && (!displayDomain.items || displayDomain.items.length === 0) ? "mt-0" : "")}>
                                <div className="px-3 pb-2 pt-1 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                                    {group.title}
                                </div>
                                {group.items.map((item, i) => {
                                    const isItemActive = pathname === item.href || (item.href !== '/' && !!item.href && pathname.startsWith(item.href));
                                    return (
                                        <Link
                                            key={item.href || i}
                                            href={item.href}
                                            onClick={handleLinkClick}
                                            className={cn(
                                                "group relative flex items-center w-full h-[40px] px-3 rounded-md transition-colors text-sm",
                                                isItemActive 
                                                    ? "bg-[#eef2ff] text-[#4f46e5] font-medium" 
                                                    : "text-gray-700 hover:bg-[#f9fafb]"
                                            )}
                                        >
                                            <div className={cn(
                                                "absolute left-0 w-[3px] h-[20px] rounded-r-full transition-colors",
                                                isItemActive ? "bg-[#4f46e5]" : "bg-transparent"
                                            )} />
                                            <item.icon className={cn("w-[20px] h-[20px] mr-3 z-10", isItemActive ? "text-[#4f46e5]" : "text-[#6b7280] group-hover:text-gray-900")} />
                                            <span className="z-10">{item.label}</span>
                                        </Link>
                                    )
                                })}
                            </div>
                        ))}
                    </div>
                </aside>
            </div>
        </TooltipProvider>
    );
}
