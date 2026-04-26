"use client";

import { User, LogOut, ChevronDown, Shield, Briefcase, Inbox } from "lucide-react";
import Link from "next/link";
import { useState, useEffect } from 'react';
import { getUsers, getCurrentUser, login, logout } from '@/lib/users/user-service';
import GlobalSearch from "@/components/layout/GlobalSearch";

export default function TopBar() {
    const [users, setUsers] = useState<any[]>([]);
    const [currentUser, setCurrentUser] = useState<any>(null);
    const [isOpen, setIsOpen] = useState(false);

    useEffect(() => {
        getUsers().then(setUsers);
        getCurrentUser().then(setCurrentUser);
    }, []);
    
    return (
        <header className="fixed top-0 left-0 lg:left-[72px] right-0 h-[64px] z-40 bg-background border-b flex items-center justify-between px-6 transition-all duration-300">
            <div className="flex items-center gap-4">
                <div className="flex items-center justify-center lg:hidden mr-2">
                    {/* Mobile Logo Placeholder */}
                    <div className="flex h-8 w-8 items-center justify-center rounded bg-primary text-primary-foreground font-bold">
                        Y
                    </div>
                </div>
                <span className="text-lg font-semibold max-lg:hidden">
                    Yoko CRM
                </span>
            </div>

            
            <div className="flex items-center gap-3">
                <div className="flex items-center gap-1 bg-secondary hover:bg-secondary/80 px-2.5 py-1 rounded-full text-[13px] font-semibold transition-colors">
                    {(!currentUser || currentUser.role === 'Администратор') ? (
                        <div className="relative">
                            <button 
                                onClick={() => setIsOpen(!isOpen)} 
                                className="flex items-center gap-1 cursor-pointer text-foreground text-[12px] outline-none"
                            >
                                <User className="h-3.5 w-3.5 text-muted-foreground" />
                                <span>{currentUser ? `${currentUser.firstName} ${currentUser.lastName}` : 'Войти...'}</span>
                                <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            </button>
                            {isOpen && (
                                <div className="absolute top-full right-0 mt-1 bg-white border border-gray-100 rounded-xl shadow-lg z-50 w-48 overflow-hidden">
                                     {users.map(u => (
                                         <button 
                                             key={u.id}
                                             onClick={async () => {
                                                 const { login } = await import('@/lib/users/user-service');
                                                 await login(u.id);
                                                 setIsOpen(false);
                                                 window.location.reload();
                                             }}
                                             className="w-full flex items-center gap-2 px-3 py-2 text-[12px] hover:bg-gray-50 text-left cursor-pointer border-none"
                                         >
                                             {u.role === 'Администратор' && <Shield className="w-3.5 h-3.5 text-red-500" />}
                                             {u.role === 'Руководитель' && <Briefcase className="w-3.5 h-3.5 text-blue-500" />}
                                             {u.role === 'Менеджер' && <User className="w-3.5 h-3.5 text-gray-400" />}
                                             <div className="flex flex-col">
                                                 <span className="font-semibold text-gray-900">{u.firstName} {u.lastName}</span>
                                                 <span className="text-[10px] text-gray-400">{u.role}</span>
                                             </div>
                                         </button>
                                     ))}
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="flex items-center gap-1 ml-1 text-[12px] text-foreground">
                            {currentUser.role === 'Администратор' && <Shield className="w-3.5 h-3.5 text-red-500" />}
                            {currentUser.role === 'Руководитель' && <Briefcase className="w-3.5 h-3.5 text-blue-500" />}
                            {currentUser.role === 'Менеджер' && <User className="w-3.5 h-3.5 text-gray-400" />}
                            <span>{currentUser.firstName} {currentUser.lastName}</span>
                        </div>
                    )}
                    {currentUser && (
                        <button 
                            onClick={async () => {
                                const { logout } = await import('@/lib/users/user-service');
                                await logout();
                                window.location.href = '/login';
                            }}
                            className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors ml-1 cursor-pointer"
                            title="Выйти"
                        >
                            <LogOut className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
                <Link
                    href="/leads/new"
                    title="Все новые лиды (Avito, Сайт, WhatsApp и т.д.)"
                    className="inline-flex items-center gap-1.5 rounded-full bg-secondary hover:bg-secondary/80 px-3 py-1 text-[13px] font-medium transition-colors"
                >
                    <Inbox className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>Новые лиды</span>
                </Link>
                <GlobalSearch />
            </div>
        </header>
    );
}
