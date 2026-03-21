import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { fetchUsers, fetchBots, broadcastMessage } from '../../lib/api';
import CustomSelect from '../../components/CustomSelect';

export default function UsersList() {
    const router = useRouter();
    const [users, setUsers] = useState([]);
    const [bots, setBots] = useState([]);
    const [selectedBotId, setSelectedBotId] = useState('');
    const [funnelFilter, setFunnelFilter] = useState('');
    const [loading, setLoading] = useState(true);
    const [totalUsers, setTotalUsers] = useState(0);

    // Modal State
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [broadcastSegment, setBroadcastSegment] = useState('ALL');
    const [broadcastText, setBroadcastText] = useState('');
    const [broadcastStatus, setBroadcastStatus] = useState(null);

    useEffect(() => {
        if (router.isReady) {
            const { botId, filter } = router.query;
            if (botId) setSelectedBotId(botId);
            if (filter) setFunnelFilter(filter);
            loadInitialData(botId);
        }
    }, [router.isReady, router.query]);

    useEffect(() => {
        if (selectedBotId) {
            loadUsers(selectedBotId, funnelFilter);
        }
    }, [selectedBotId, funnelFilter]);

    const loadInitialData = async (initialBotId) => {
        try {
            const data = await fetchBots();
            setBots(data);
            if (data.length > 0) {
                if (!initialBotId) {
                    setSelectedBotId(data[0].id);
                }
            } else {
                setLoading(false);
            }
        } catch (error) {
            console.error(error);
            setLoading(false);
        }
    };

    const loadUsers = async (botId, filter) => {
        setLoading(true);
        try {
            const data = await fetchUsers({ botId, filter, take: 100 });
            setUsers(data.data || []);
            setTotalUsers(data.total || 0);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    const handleBroadcastSubmit = async (e) => {
        e.preventDefault();
        if (!broadcastText.trim()) return;

        setBroadcastStatus('sending');
        try {
            await broadcastMessage({
                botId: selectedBotId,
                segment: broadcastSegment,
                text: broadcastText
            });
            setBroadcastStatus('success');
            setTimeout(() => {
                setIsModalOpen(false);
                setBroadcastStatus(null);
                setBroadcastText('');
            }, 2000);
        } catch (error) {
            console.error(error);
            setBroadcastStatus('error');
        }
    };

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="neu-panel p-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white drop-shadow-md">Аудитория</h1>
                    <p className="text-slate-400 text-sm mt-1">Они запускали ваших ботов. Всего: <span className="font-bold text-neu-accent bg-neu-base shadow-neu-inner px-2 py-0.5 rounded-md border border-white/[0.02]">{totalUsers}</span> чел.</p>
                </div>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-5 w-full sm:w-auto">
                    <div className="flex bg-neu-base shadow-neu-inner border border-black/20 rounded-xl p-1 overflow-visible flex-1 sm:flex-none h-[42px] gap-1">
                        <CustomSelect
                            value={selectedBotId}
                            onChange={setSelectedBotId}
                            compact
                            placeholder="Все Проекты"
                            options={[
                                { value: '', label: 'Все Проекты' },
                                ...bots.map(b => ({ value: b.id, label: b.name }))
                            ]}
                            className="w-36"
                        />
                        <div className="w-px bg-white/[0.05] mx-0.5 flex-shrink-0"></div>
                        <CustomSelect
                            value={funnelFilter}
                            onChange={setFunnelFilter}
                            compact
                            placeholder="Без фильтра воронки"
                            options={[
                                { value: '', label: 'Без фильтра воронки' },
                                { value: 'entered', label: 'Зашли в бота' },
                                { value: 'started', label: 'Начали опрос' },
                                { value: 'started_survey', label: 'Бросили опрос' },
                                { value: 'completed', label: 'Завершили опрос' },
                            ]}
                            className="w-52"
                        />
                    </div>

                    <button
                        onClick={() => setIsModalOpen(true)}
                        disabled={!selectedBotId && bots.length === 0}
                        className="neu-button-primary disabled:opacity-50 disabled:shadow-neu disabled:cursor-not-allowed !py-2 !h-[42px]"
                    >
                        <svg className="w-5 h-5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" /></svg>
                        Рассылка
                    </button>
                </div>
            </div>

            {/* Main Table */}
            <div className="neu-panel overflow-hidden w-full">
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-white/[0.02]">
                        <thead className="bg-[#1c1e22]/50 border-b border-black/20">
                            <tr>
                                <th scope="col" className="px-4 py-4 text-left font-semibold text-slate-400 uppercase tracking-wider text-[10px] drop-shadow-sm">Профиль Telegram</th>
                                <th scope="col" className="px-4 py-4 text-left font-semibold text-slate-400 uppercase tracking-wider text-[10px] hidden sm:table-cell drop-shadow-sm">Бот</th>
                                <th scope="col" className="px-4 py-4 text-left font-semibold text-slate-400 uppercase tracking-wider text-[10px] drop-shadow-sm">Статус</th>
                                <th scope="col" className="px-4 py-4 text-left font-semibold text-slate-400 uppercase tracking-wider text-[10px] drop-shadow-sm">ФИО</th>
                                <th scope="col" className="px-4 py-4 text-left font-semibold text-slate-400 uppercase tracking-wider text-[10px] drop-shadow-sm">Телефон</th>
                                <th scope="col" className="px-4 py-4 text-left font-semibold text-slate-400 uppercase tracking-wider text-[10px] drop-shadow-sm">Зашли в бота</th>
                                <th scope="col" className="px-4 py-4 text-left font-semibold text-slate-400 uppercase tracking-wider text-[10px] drop-shadow-sm">Начали опрос</th>
                                <th scope="col" className="px-4 py-4 text-right font-semibold text-slate-400 uppercase tracking-wider text-[10px] drop-shadow-sm">Завершили опрос</th>
                            </tr>
                        </thead>
                        <tbody className="bg-transparent divide-y divide-white/[0.02]">
                            {loading ? (
                                <tr>
                                    <td colSpan="8" className="px-6 py-16 text-center">
                                        <div className="flex flex-col items-center justify-center space-y-4">
                                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-t-2 border-neu-accent shadow-neu-glow"></div>
                                            <span className="text-sm text-slate-400 font-medium tracking-wide">Загрузка данных...</span>
                                        </div>
                                    </td>
                                </tr>
                            ) : users.length === 0 ? (
                                <tr>
                                    <td colSpan="8" className="px-6 py-16 text-center">
                                        <div className="flex flex-col items-center text-slate-500">
                                            <div className="w-16 h-16 bg-neu-base shadow-neu-inner rounded-full flex items-center justify-center mb-4">
                                                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                                            </div>
                                            <p className="text-sm font-medium">Нет пользователей по выбранному фильтру.</p>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                users.map((user) => (
                                    <tr key={user.id} className="hover:bg-white/[0.02] transition-colors group">
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <div className="flex items-center gap-4">
                                                <div className="flex-shrink-0 h-10 w-10 flex items-center justify-center rounded-full bg-neu-base shadow-neu-inner text-neu-accent font-bold group-hover:shadow-neu-glow transition-all duration-300 border border-black/20">
                                                    {(user.firstName || user.username || '?').charAt(0).toUpperCase()}
                                                </div>
                                                <div>
                                                    <div className="text-sm font-bold text-slate-200 tracking-tight group-hover:text-white transition-colors">{user.username ? `@${user.username} ` : (user.firstName || 'Скрытое имя')}</div>
                                                    <div className="text-xs text-slate-500 font-mono mt-0.5">{user.telegramId}</div>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap hidden sm:table-cell">
                                            <span className="inline-flex items-center px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-neu-base shadow-neu flex items-center justify-center text-slate-400 border border-white/[0.02]">
                                                {user.bot?.name || 'Удаленный бот'}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            {(() => {
                                                if (user.dateCompletedSurvey) return (
                                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]"></span>
                                                        Завершил
                                                    </span>
                                                );
                                                if (user.dateStartedSurvey) return (
                                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]"></span>
                                                        Бросил опрос
                                                    </span>
                                                );
                                                if (user.dateStartedBot) return (
                                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-blue-500/10 text-blue-400 border border-blue-500/20">
                                                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shadow-[0_0_6px_rgba(96,165,250,0.8)]"></span>
                                                        Зашёл в бота
                                                    </span>
                                                );
                                                return (
                                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-slate-500/10 text-slate-400 border border-slate-500/20">
                                                        <span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
                                                        Неизвестно
                                                    </span>
                                                );
                                            })()}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <span className="text-sm font-medium text-slate-300">{user.fio || '-'}</span>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <span className="text-sm font-mono text-slate-400">{user.phone || '-'}</span>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-xs font-medium text-slate-500">
                                            {user.dateStartedBot ? new Date(user.dateStartedBot).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + new Date(user.dateStartedBot).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '-'}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-xs font-medium text-amber-400/80">
                                            {user.dateStartedSurvey ? new Date(user.dateStartedSurvey).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + new Date(user.dateStartedSurvey).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '-'}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-right text-xs font-medium text-emerald-400/80">
                                            {user.dateCompletedSurvey ? new Date(user.dateCompletedSurvey).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + new Date(user.dateCompletedSurvey).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '-'}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Broadcast Modal */}
            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-md animate-in fade-in duration-200">
                    <div className="bg-neu-base shadow-[10px_10px_20px_#15171a,-10px_-10px_20px_#2f333a] border border-white/[0.05] rounded-2xl max-w-lg w-full overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="px-6 py-5 border-b border-white/[0.05] flex items-center gap-3">
                            <div className="p-2 bg-neu-base shadow-neu-inner text-neu-accent rounded-xl border border-black/20">
                                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828z" /><path fillRule="evenodd" d="M2 6a2 2 0 012-2h4a1 1 0 010 2H4v10h10v-4a1 1 0 112 0v4a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clipRule="evenodd" /></svg>
                            </div>
                            <h3 className="text-xl font-bold tracking-tight text-white drop-shadow-sm">Рассылка (MVP)</h3>
                        </div>
                        <form onSubmit={handleBroadcastSubmit} className="p-6">
                            <div className="space-y-5">
                                <div className="grid grid-cols-2 gap-5">
                                    <div>
                                        <label className="block text-sm font-medium text-slate-400 mb-2">Отправитель (Бот)</label>
                                        <CustomSelect
                                            value={selectedBotId}
                                            onChange={setSelectedBotId}
                                            options={bots.map(b => ({ value: b.id, label: b.name }))}
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-slate-400 mb-2">Сегмент</label>
                                        <CustomSelect
                                            value={broadcastSegment}
                                            onChange={setBroadcastSegment}
                                            options={[
                                                { value: 'ALL', label: 'Вся аудитория' },
                                                { value: 'STARTED_BOT_ONLY', label: 'Только старт' },
                                                { value: 'STARTED_SURVEY', label: 'Бросили опрос' },
                                                { value: 'COMPLETED_SURVEY', label: 'Прошли опрос' },
                                            ]}
                                        />
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-slate-400 mb-2">Текст сообщения</label>
                                    <textarea
                                        rows={4}
                                        required
                                        value={broadcastText}
                                        onChange={(e) => setBroadcastText(e.target.value)}
                                        className="w-full neu-input resize-none focus:ring-neu-accent focus:shadow-neu-glow"
                                        placeholder="Скидка 20% для тех, кто завершит опрос сегодня!"
                                    />
                                </div>

                                {/* Status Messages */}
                                {broadcastStatus === 'sending' && (
                                    <div className="p-4 bg-neu-base shadow-neu-inner text-neu-accent text-sm font-medium rounded-xl border border-black/20 flex items-center gap-3">
                                        <div className="w-4 h-4 rounded-full border-2 border-neu-accent border-t-transparent shadow-neu-glow animate-spin"></div>
                                        Рассылка запущена в фоновом режиме...
                                    </div>
                                )}
                                {broadcastStatus === 'success' && (
                                    <div className="p-4 bg-neu-base shadow-neu-inner text-emerald-400 text-sm font-medium rounded-xl border border-black/20 flex items-center gap-3">
                                        <svg className="w-5 h-5 drop-shadow-[0_0_5px_rgba(52,211,153,0.5)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                        Успешно! Рассылка идет. Завершаем работу.
                                    </div>
                                )}
                                {broadcastStatus === 'error' && (
                                    <div className="p-4 bg-neu-base shadow-neu-inner text-red-400 text-sm font-medium rounded-xl border border-black/20 flex items-center gap-3">
                                        <svg className="w-5 h-5 drop-shadow-[0_0_5px_rgba(248,113,113,0.5)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                        Ошибка при запуске рассылки.
                                    </div>
                                )}
                            </div>
                            <div className="mt-8 flex gap-4">
                                <button
                                    type="button"
                                    onClick={() => setIsModalOpen(false)}
                                    disabled={broadcastStatus === 'sending' || broadcastStatus === 'success'}
                                    className="flex-1 neu-button !text-slate-400 disabled:opacity-50 disabled:shadow-neu"
                                >
                                    Отмена
                                </button>
                                <button
                                    type="submit"
                                    disabled={broadcastStatus === 'sending' || broadcastStatus === 'success' || !broadcastText.trim()}
                                    className="flex-1 neu-button-primary disabled:opacity-50 disabled:shadow-neu"
                                >
                                    Отправить
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
