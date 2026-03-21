import { useState, useEffect } from 'react';
import { fetchBots, createBot } from '../lib/api';
import Link from 'next/link';

export default function BotsList() {
    const [bots, setBots] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [newBotToken, setNewBotToken] = useState('');
    const [newBotName, setNewBotName] = useState('');

    useEffect(() => {
        loadBots();
    }, []);

    const loadBots = async () => {
        try {
            const data = await fetchBots();
            setBots(data);
        } catch (error) {
            console.error('Bot load error:', error);
            const errorMsg = error.response?.data?.error || error.message || 'Ошибка при загрузке ботов';
            alert(`Ошибка: ${errorMsg}`);
        } finally {
            setLoading(false);
        }
    };

    const handleCreateBot = async (e) => {
        e.preventDefault();
        try {
            await createBot({ token: newBotToken, name: newBotName, username: `@${newBotName.replace(/\s+/g, '')}` });
            setShowModal(false);
            setNewBotToken('');
            setNewBotName('');
            loadBots();
        } catch (err) {
            console.error('Bot creation error:', err);
            const errorMsg = err.response?.data?.error || 'Неизвестная ошибка при создании бота';
            alert(`Ошибка: ${errorMsg}`);
        }
    };

    if (loading) return (
        <div className="flex items-center justify-center min-h-[400px]">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-t-2 border-neu-accent shadow-neu-glow"></div>
        </div>
    );

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="sm:flex sm:items-center sm:justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white drop-shadow-md">Управление Проектами</h1>
                    <p className="text-slate-400 text-sm mt-1">Список всех подключенных Telegram-ботов</p>
                </div>
                <button
                    onClick={() => setShowModal(true)}
                    className="mt-4 sm:mt-0 neu-button-primary"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                    Добавить бота
                </button>
            </div>

            {bots.length === 0 ? (
                <div className="neu-panel-inner p-12 text-center flex flex-col items-center justify-center border-dashed border-2 border-[#2b2f35]">
                    <div className="w-16 h-16 bg-neu-base shadow-neu rounded-full flex items-center justify-center mb-4 text-slate-500">
                        <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                    </div>
                    <h3 className="text-lg font-medium text-white">Нет ботов</h3>
                    <p className="text-slate-400 mt-1">Добавьте своего первого бота, чтобы начать.</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {bots.map((bot) => (
                        <Link key={bot.id} href={`/bots/${bot.id}`} className="block group">
                            <div className="neu-panel p-6 h-full flex flex-col relative overflow-hidden transition-all duration-300 hover:shadow-[8px_8px_16px_#191b1f,-8px_-8px_16px_#2b2f35]">
                                <div className="absolute top-0 right-0 p-4">
                                    <span className={`px-3 py-1 text-[10px] uppercase tracking-wider font-bold rounded-full shadow-neu-inner ${bot.isActive ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {bot.isActive ? 'Активен' : 'Отключен'}
                                    </span>
                                </div>
                                <div className="flex items-center gap-4 mb-4 mt-2">
                                    <div className="w-12 h-12 bg-neu-base shadow-neu-inner rounded-xl flex items-center justify-center text-neu-accent group-hover:shadow-neu-glow transition-all duration-300">
                                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5" /></svg>
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-bold text-white group-hover:text-neu-accent transition-colors drop-shadow-sm">{bot.name}</h3>
                                        <p className="text-xs text-slate-500 font-medium">ID: {bot.id.substring(0, 8)}</p>
                                    </div>
                                </div>

                                <div className="mt-auto pt-4 flex items-center justify-between border-t border-white/[0.02]">
                                    <div className="flex flex-col">
                                        <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">Всего Лидов</span>
                                        <span className="font-semibold text-slate-300">{bot._count?.users || 0}</span>
                                    </div>
                                    <div className="w-8 h-8 rounded-full bg-neu-base shadow-neu flex items-center justify-center text-slate-400 group-hover:text-neu-accent transition-colors group-hover:shadow-neu-inner">
                                        <svg className="w-4 h-4 translate-x-[1px]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                    </div>
                                </div>
                            </div>
                        </Link>
                    ))}
                </div>
            )}

            {showModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-md animate-in fade-in duration-200">
                    <div className="bg-neu-base shadow-[10px_10px_20px_#15171a,-10px_-10px_20px_#2f333a] border border-white/[0.05] rounded-2xl max-w-md w-full overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="px-6 py-5 border-b border-white/[0.05]">
                            <h3 className="text-lg font-semibold text-white">Подключение нового бота</h3>
                        </div>
                        <form onSubmit={handleCreateBot} className="p-6">
                            <div className="space-y-5">
                                <div>
                                    <label className="block text-sm font-medium text-slate-400 mb-2">Название проекта</label>
                                    <input
                                        type="text"
                                        required
                                        className="w-full neu-input"
                                        value={newBotName}
                                        onChange={e => setNewBotName(e.target.value)}
                                        placeholder="Например: HR Опросник"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-slate-400 mb-2">Telegram Bot Token</label>
                                    <input
                                        type="text"
                                        required
                                        className="w-full neu-input font-mono text-sm"
                                        value={newBotToken}
                                        onChange={e => setNewBotToken(e.target.value)}
                                        placeholder="123456:ABC-DEF1234ghIkl..."
                                    />
                                </div>
                            </div>
                            <div className="mt-8 flex gap-4">
                                <button
                                    type="button"
                                    onClick={() => setShowModal(false)}
                                    className="flex-1 neu-button !text-slate-400"
                                >
                                    Отмена
                                </button>
                                <button
                                    type="submit"
                                    className="flex-1 neu-button-primary"
                                >
                                    Создать
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
