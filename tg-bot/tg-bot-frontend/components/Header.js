import { useAuth } from '../context/AuthContext';

export default function Header() {
    const { logout } = useAuth();

    return (
        <header className="sticky top-0 z-40 bg-neu-base/80 backdrop-blur-xl border-b border-[#2b2f35]/30 px-6 sm:px-8 py-4 shadow-sm">
            <div className="max-w-7xl mx-auto flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <h1 className="text-xl font-bold text-foreground tracking-tight drop-shadow-sm">
                        Панель Управления
                    </h1>
                </div>

                <div className="flex items-center gap-4">
                    <button
                        onClick={logout}
                        className="neu-button !py-2 !px-4 !rounded-lg text-sm text-slate-400 hover:text-neu-secondary"
                    >
                        <span>Выйти</span>
                        <svg className="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                    </button>
                </div>
            </div>
        </header>
    );
}
