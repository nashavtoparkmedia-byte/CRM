import { useState, useEffect } from 'react';
import api, { fetchSurveysStats, fetchBots, updateSurvey } from '../../lib/api';
import Link from 'next/link';
import { useRouter } from 'next/router';
import CustomSelect from '../../components/CustomSelect';

export default function SurveysList() {
    const router = useRouter();
    const [surveys, setSurveys] = useState([]);
    const [bots, setBots] = useState([]);
    const [loading, setLoading] = useState(true);
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const [newSurveyData, setNewSurveyData] = useState({ triggerButton: '', botId: '', isLinear: true });
    const [activeTab, setActiveTab] = useState('ACTIVE'); // ACTIVE, ARCHIVED
    const [duplicatingId, setDuplicatingId] = useState(null);
    const [archivePrompt, setArchivePrompt] = useState(null); // survey object или null

    useEffect(() => {
        loadSurveys();
    }, []);

    const loadSurveys = async () => {
        try {
            const [data, botsData] = await Promise.all([
                fetchSurveysStats(),
                fetchBots()
            ]);
            setSurveys(data);
            setBots(botsData);
            if (botsData.length > 0 && !newSurveyData.botId) {
                setNewSurveyData(prev => ({ ...prev, botId: botsData[0].id }));
            }
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    const handleCreateSurvey = async (e) => {
        e.preventDefault();
        try {
            const payload = {
                botId: newSurveyData.botId,
                triggerButton: newSurveyData.triggerButton,
                isLinear: newSurveyData.isLinear
            };
            await api.post('/surveys', payload);
            setIsCreateModalOpen(false);
            setNewSurveyData({ triggerButton: '', botId: bots[0]?.id || '', isLinear: true });
            await loadSurveys();
        } catch (err) {
            alert('Ошибка создания опроса. Убедитесь, что сервер включен.');
            console.error('Create survey errored:', err.response?.data || err.message);
        }
    };

    const handleToggleActive = (e, survey) => {
        e.preventDefault();
        e.stopPropagation();
        if (survey.isActive) {
            // При выключении — показываем диалог
            setArchivePrompt(survey);
        } else {
            // При включении — сразу включаем
            confirmToggle(survey, false, true);
        }
    };

    const confirmToggle = async (survey, shouldArchive, isActive) => {
        try {
            const payload = { ...survey, isActive };
            if (shouldArchive) payload.archivedAt = new Date().toISOString();
            else if (isActive) payload.archivedAt = null;
            const updated = await updateSurvey(survey.id, payload);
            setSurveys(prev => prev.map(s => s.id === survey.id
                ? { ...s, isActive: updated.isActive, archivedAt: updated.archivedAt }
                : s
            ));
        } catch (err) {
            console.error('Ошибка при смене статуса:', err);
        } finally {
            setArchivePrompt(null);
        }
    };

    const formatDate = (dateString) => {
        if (!dateString) return '';
        return new Date(dateString).toLocaleDateString('ru-RU');
    };

    if (loading) return (
        <div className="flex items-center justify-center min-h-[400px]">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-t-2 border-neu-accent shadow-neu-glow"></div>
        </div>
    );

    const activeSurveys = surveys.filter(s => !s.archivedAt);
    const archivedSurveys = surveys.filter(s => s.archivedAt);

    const displayedSurveys = activeTab === 'ACTIVE' ? activeSurveys : archivedSurveys;

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">

            {/* ARCHIVE PROMPT MODAL */}
            {archivePrompt && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-md animate-in fade-in duration-200">
                    <div className="bg-neu-base shadow-[10px_10px_20px_#202227,-10px_-10px_20px_#4a505b] border border-white/[0.05] rounded-2xl max-w-md w-full overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="px-6 py-5 border-b border-white/[0.05]">
                            <h3 className="text-xl font-bold text-white mb-2 flex items-center gap-3">
                                <div className="p-2 bg-neu-base shadow-neu-inner text-purple-400 rounded-xl border border-black/20">
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>
                                </div>
                                Скрытие опроса
                            </h3>
                            <p className="text-sm text-slate-400">
                                Вы выключаете опрос. Как поступить с собранными ответами и самим опросом?
                            </p>
                        </div>
                        <div className="p-6 space-y-4">
                            <button
                                onClick={() => confirmToggle(archivePrompt, true, false)}
                                className="w-full text-left bg-neu-base shadow-neu border border-white/[0.05] hover:border-purple-500/30 p-4 rounded-xl transition-all group"
                            >
                                <h4 className="font-bold text-purple-400 group-hover:text-purple-300">📦 Архивировать (Рекомендуется)</h4>
                                <p className="text-xs text-slate-500 mt-1">Опрос переместится в Архив (только чтение). Текущая статистика закроется, и новые ответы в нее не попадут. Вы сможете начать новый период с чистого листа.</p>
                            </button>

                            <button
                                onClick={() => confirmToggle(archivePrompt, false, false)}
                                className="w-full text-left bg-neu-base shadow-neu border border-white/[0.05] hover:border-slate-500/30 p-4 rounded-xl transition-all group"
                            >
                                <h4 className="font-bold text-slate-300 group-hover:text-white">🔴 Просто скрыть из бота</h4>
                                <p className="text-xs text-slate-500 mt-1">Опрос пропадет из меню бота, но останется во вкладке "Активные". Ответы будут записываться в текущую статистику, если вы его потом включите.</p>
                            </button>

                            <button
                                onClick={() => setArchivePrompt(null)}
                                className="w-full mt-2 py-3 text-sm font-bold text-slate-500 hover:text-white transition-colors"
                            >
                                Отмена
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="sm:flex sm:items-center sm:justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white drop-shadow-md">Конструктор Опросов</h1>
                    <p className="text-slate-400 text-sm mt-1">Создавайте, настраивайте и анализируйте опросы в ботах</p>
                </div>
                <button
                    onClick={() => setIsCreateModalOpen(true)}
                    className="mt-4 sm:mt-0 neu-button-primary !text-emerald-400 hover:shadow-[4px_4px_8px_#26292f,-4px_-4px_8px_#444953,0_0_15px_rgba(52,211,153,0.4)] active:!text-emerald-300"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                    Новый опрос
                </button>
            </div>

            {/* CREATE MODAL */}
            {isCreateModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-md animate-in fade-in duration-200">
                    <div className="bg-neu-base shadow-[10px_10px_20px_#202227,-10px_-10px_20px_#4a505b] border border-white/[0.05] rounded-2xl max-w-md w-full overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="px-6 py-5 border-b border-white/[0.05]">
                            <h3 className="text-lg font-semibold text-white">Создание нового опроса</h3>
                        </div>
                        <form onSubmit={handleCreateSurvey} className="p-6 space-y-5">
                            <div>
                                <label className="block text-sm font-medium text-slate-400 mb-2">Бот для опроса</label>
                                <CustomSelect
                                    value={newSurveyData.botId}
                                    onChange={(val) => setNewSurveyData({ ...newSurveyData, botId: val })}
                                    options={[
                                        ...bots.map(b => ({ value: b.id, label: b.name })),
                                        ...(bots.length === 0 ? [{ value: '', label: 'Нет созданных ботов' }] : [])
                                    ]}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-400 mb-2">Кнопка-триггер (Название опроса)</label>
                                <input
                                    type="text"
                                    required
                                    value={newSurveyData.triggerButton}
                                    onChange={(e) => setNewSurveyData({ ...newSurveyData, triggerButton: e.target.value })}
                                    className="w-full neu-input focus:ring-emerald-400 focus:shadow-[0_0_10px_rgba(52,211,153,0.3),0_0_20px_rgba(52,211,153,0.1)]"
                                    placeholder="📊 Запуск"
                                />
                                <p className="text-xs text-slate-500 mt-2 flex items-center gap-1.5">
                                    <svg className="w-3.5 h-3.5 text-emerald-400 mb-0.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" /></svg>
                                    Точный текст кнопки, по которой юзер запустит этот опрос в боте. Это же имя будет использоваться в Архиве. После создания изменить его будет нельзя.
                                </p>
                            </div>

                            <div className="bg-neu-base shadow-neu-inner px-5 py-3 rounded-2xl border border-black/20 flex items-center justify-between">
                                <span className="text-sm font-medium text-slate-400">Режим прохождения</span>
                                <div className="flex items-center space-x-3">
                                    <span className={`text-xs tracking-wide ${newSurveyData.isLinear ? 'font-bold text-neu-accent' : 'text-slate-500'}`}>Линейно</span>
                                    <button
                                        type="button"
                                        onClick={() => setNewSurveyData({ ...newSurveyData, isLinear: !newSurveyData.isLinear })}
                                        className="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none shadow-neu-inner bg-[#191b1f]"
                                    >
                                        <span className={`inline-block h-5 w-5 transform rounded-full shadow-neu transition duration-300 ease-in-out ${newSurveyData.isLinear ? 'translate-x-0 bg-neu-accent' : 'translate-x-5 bg-neu-secondary'}`} />
                                    </button>
                                    <span className={`text-xs tracking-wide ${!newSurveyData.isLinear ? 'font-bold text-neu-secondary' : 'text-slate-500'}`}>Ветвление</span>
                                </div>
                            </div>

                            <div className="pt-4 flex gap-4">
                                <button
                                    type="button"
                                    onClick={() => setIsCreateModalOpen(false)}
                                    className="flex-1 neu-button !text-slate-400"
                                >
                                    Отмена
                                </button>
                                <button
                                    type="submit"
                                    className="flex-1 neu-button-primary !text-emerald-400 hover:shadow-[4px_4px_8px_#26292f,-4px_-4px_8px_#444953,0_0_15px_rgba(52,211,153,0.4)]"
                                >
                                    Создать
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* TAB NAVIGATION */}
            <div className="flex gap-4 border-b border-[#26292f] pb-4">
                <button
                    onClick={() => setActiveTab('ACTIVE')}
                    className={`px-5 py-2.5 rounded-xl font-bold transition-all ${activeTab === 'ACTIVE' ? 'bg-neu-base shadow-neu-inner text-emerald-400 border border-black/20' : 'text-slate-500 hover:text-slate-300 shadow-neu bg-neu-base border border-white/[0.02]'}`}
                >
                    Активные ({activeSurveys.length})
                </button>
                <button
                    onClick={() => setActiveTab('ARCHIVED')}
                    className={`px-5 py-2.5 rounded-xl font-bold transition-all ${activeTab === 'ARCHIVED' ? 'bg-neu-base shadow-neu-inner text-purple-400 border border-black/20' : 'text-slate-500 hover:text-slate-300 shadow-neu bg-neu-base border border-white/[0.02]'}`}
                >
                    Архив ({archivedSurveys.length})
                </button>
            </div>

            {/* LIST */}
            <div className="neu-panel overflow-hidden w-full">
                {displayedSurveys.length === 0 ? (
                    <div className="p-12 text-center flex flex-col items-center">
                        <div className="w-16 h-16 bg-neu-base shadow-neu-inner rounded-full flex items-center justify-center mb-4 text-slate-500">
                            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" /></svg>
                        </div>
                        <h3 className="text-lg font-medium text-white">Опросов пока нет</h3>
                        <p className="text-slate-400 mt-1 max-w-sm mx-auto">Здесь пусто. Попробуйте переключить вкладку или добавить новый опрос.</p>
                    </div>
                ) : (
                    <ul className="divide-y divide-white/[0.02]">
                        {displayedSurveys.map((survey) => (
                            <li key={survey.id} className={`p-5 hover:bg-white/[0.02] transition-colors group flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${survey.archivedAt ? 'opacity-70 saturate-50' : (!survey.isActive ? 'opacity-90 saturate-75' : '')}`}>
                                <div className="flex items-center gap-5">
                                    <div className="hidden sm:flex w-12 h-12 rounded-full bg-neu-base shadow-neu-inner items-center justify-center group-hover:shadow-neu-glow transition-all relative">
                                        <button
                                            type="button"
                                            onClick={(e) => !survey.archivedAt && handleToggleActive(e, survey)}
                                            title={survey.archivedAt ? 'Архивирован' : survey.isActive ? 'Нажмите чтобы выключить' : 'Нажмите чтобы включить'}
                                            className={`w-full h-full rounded-full flex items-center justify-center transition-all duration-200 ${!survey.archivedAt ? 'cursor-pointer hover:scale-110 active:scale-95' : 'cursor-default'}`}
                                        >
                                            {survey.isActive ? (
                                                <svg className="w-6 h-6 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                            ) : (
                                                survey.archivedAt ? (
                                                    <svg className="w-6 h-6 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>
                                                ) : (
                                                    <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                                )
                                            )}
                                        </button>
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-3 mb-1.5">
                                            <h3 className="text-base font-bold text-white group-hover:text-neu-accent transition-colors drop-shadow-sm flex items-center gap-2">
                                                {survey.triggerButton || 'Безымянный'}
                                                <span className="text-xs font-normal text-slate-400 ml-1">
                                                    {!survey.archivedAt
                                                        ? `(с ${formatDate(survey.createdAt)}) ${!survey.isActive ? '— 🔴 Выключен' : ''}`
                                                        : `(${formatDate(survey.createdAt)} — ${formatDate(survey.archivedAt)})`}
                                                </span>
                                            </h3>
                                            <span className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md shadow-neu-inner text-slate-400 border border-black/20">{survey.botName}</span>
                                        </div>
                                        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-slate-400">
                                            <div className="flex items-center gap-2">
                                                <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                                                <span className="font-medium text-slate-300">{survey.totalUsers} <span className="text-slate-500">ответов</span></span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="bg-neu-base shadow-neu px-2 py-0.5 rounded text-[11px] font-mono text-neu-secondary border border-white/[0.02]">{survey.title || 'Новый опрос'}</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex flex-wrap gap-2 w-full sm:w-auto mt-3 sm:mt-0 justify-end">
                                    <Link
                                        href={`/surveys/${survey.id}`}
                                        className="flex-1 sm:flex-none neu-button-primary !py-2 !px-3 !text-sm whitespace-nowrap"
                                    >
                                        Открыть
                                    </Link>
                                    <Link
                                        href={`/surveys/${survey.id}#responses`}
                                        className="flex-1 sm:flex-none neu-button-primary !py-2 !px-4 !text-sm"
                                    >
                                        <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                                        Аналитика
                                    </Link>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div >
    );
}
