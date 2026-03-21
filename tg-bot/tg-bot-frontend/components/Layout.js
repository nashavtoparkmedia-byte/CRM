import Header from './Header';
import Sidebar from './Sidebar';

export default function Layout({ children }) {
    return (
        <div className="flex bg-background min-h-screen font-sans text-foreground antialiased selection:bg-neu-accent/30 selection:text-white">
            <Sidebar />
            <div className="flex-1 flex flex-col relative overflow-hidden bg-background">
                {/* Decorative background ambient glow (Neumorphism works best with subtle lighting) */}
                <div className="absolute top-0 right-0 -mr-32 -mt-32 w-[30rem] h-[30rem] rounded-full bg-neu-accent/5 blur-[100px] pointer-events-none"></div>
                <div className="absolute bottom-0 left-64 -ml-32 -mb-32 w-[30rem] h-[30rem] rounded-full bg-neu-secondary/5 blur-[100px] pointer-events-none"></div>

                <Header />
                <main className="flex-1 overflow-x-hidden overflow-y-auto w-full z-10 p-6 sm:p-8 relative">
                    <div className="max-w-7xl mx-auto w-full">
                        {children}
                    </div>
                </main>
            </div>
        </div>
    );
}
