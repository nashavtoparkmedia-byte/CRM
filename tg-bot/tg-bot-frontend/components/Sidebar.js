import Link from 'next/link';
import { useRouter } from 'next/router';

const navItems = [
    { name: 'Dashboard', href: '/', icon: '🏠' },
    { name: 'Боты', href: '/bots', icon: '🤖' },
    { name: 'Опросы', href: '/surveys', icon: '📝' },
    { name: 'Пользователи', href: '/users', icon: '👥' },
];

export default function Sidebar() {
    const router = useRouter();

    return (
        <div className="w-64 bg-neu-base border-r border-[#2b2f35]/30 text-foreground min-h-screen flex flex-col z-20 relative">
            {/* Header / Logo Area - Neumorphic pop */}
            <div className="h-20 flex items-center px-6 mb-4">
                <div className="flex items-center gap-4 w-full justify-center">
                    <div className="w-10 h-10 rounded-xl bg-neu-base shadow-neu flex items-center justify-center text-neu-accent font-bold text-xl border border-white/[0.02]">
                        Y
                    </div>
                    <span className="text-xl font-bold tracking-wide text-foreground">
                        Hub<span className="text-neu-accent drop-shadow-[0_0_8px_rgba(0,240,255,0.5)]">Bot</span>
                    </span>
                </div>
            </div>

            {/* Navigation */}
            <nav className="flex-1 px-5 py-4 space-y-4 overflow-y-auto">
                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em] mb-6 px-2">Управление</div>
                {navItems.map((item) => {
                    const isActive = item.href === '/'
                        ? router.pathname === '/'
                        : router.pathname.startsWith(item.href);

                    return (
                        <Link key={item.name} href={item.href}>
                            <div className="mb-4">
                                <button
                                    className={`
                                        w-full flex items-center gap-4 px-4 py-3.5 rounded-xl transition-all duration-300 relative font-medium text-sm
                                        ${isActive
                                            ? 'bg-neu-base shadow-neu-inner text-neu-accent border border-black/20'
                                            : 'bg-neu-base shadow-neu text-slate-400 border border-white/[0.02] hover:text-slate-200'
                                        }
                                    `}
                                >
                                    {/* Neon Indicator line for active state */}
                                    {isActive && (
                                        <div className="absolute left-2 top-1/2 -translate-y-1/2 w-1 h-6 bg-neu-accent rounded-full shadow-neu-glow"></div>
                                    )}
                                    <span className={`text-xl transition-transform duration-300 ${isActive ? 'scale-110 drop-shadow-[0_0_5px_rgba(0,240,255,0.5)]' : 'grayscale-[50%]'}`}>
                                        {item.icon}
                                    </span>
                                    <span className="tracking-wide">{item.name}</span>
                                </button>
                            </div>
                        </Link>
                    );
                })}
            </nav>

            {/* User Footer - Displayed as a pressed/inset area */}
            <div className="p-5 mt-auto">
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-neu-base shadow-neu-inner border border-black/10 transition-colors">
                    <div className="w-10 h-10 rounded-full bg-neu-base shadow-neu flex items-center justify-center text-sm font-bold text-slate-300 border border-white/[0.02]">
                        A
                    </div>
                    <div className="flex-col flex">
                        <span className="text-sm font-medium text-slate-200">Администратор</span>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            <div className="w-1.5 h-1.5 rounded-full bg-neu-accent shadow-neu-glow animate-pulse"></div>
                            <span className="text-[10px] text-neu-accent font-medium tracking-wide">В Сети</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
